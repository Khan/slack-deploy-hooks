/**
 * Description:
 *   Send commands to jenkins.
 *
 * Dependencies:
 *   None
 *
 * Configuration:
 *   The JENKINS_API_TOKEN environment variables must be set.
 *   The SUN_DEBUG flag can be set if you want to debug this
 *     module without risking talking to Jenkins.
 *   The SLACK_BOT_TOKEN variable should be set to the Slack bot user's token,
 *     which will be used to send messages and make API calls.
 *   The SLACK_VERIFICATION_TOKEN variable should be set to the verification
 *     token Slack uses for this web service. (For testing, as long you keep
 *     it blank, it's fine.)
 *
 * Author:
 *   bmp and csilvers
 *
 * TODO(csilvers): split this up into several files.
 */

import Q from "q";
import bodyParser from "body-parser";
import express from "express";
import request from "request";
import googleapis from "googleapis";

const googleKey = require("./email_role_checker_secret.json");

const help_text = `*Commands*
  - \`sun: help\` - show the help text
  - \`sun: queue [username]\` - add someone to the deploy queue (user is "me" or of the form \`user1 + user2 (optional note)\`)
  - \`sun: up next\` - move the person at the front of the queue to deploying, and ping them
  - \`sun: remove [username]\` - remove someone from the deploy queue (user is "me" or a username)
  - \`sun: test <branch name> [+ <branch name> ...]\` - run tests on a particular branch, independent of a deploy
  - \`sun: delete znd <znd name>\` - ask Jenkins to delete the given znd
  - \`sun: prompt znd cleanup\` - check in with znd owners about cleaning up their znd
  - \`sun: history\` - print the changelogs for the 5 most recent successful deploys
  - \`sun: deploy <branch name> [+ <branch name> ...] [, cc @<username> [+ @<username> ...]]\` - deploy a particular branch (or merge multiple branches) to production, optionally CC another user(s)
  - \`sun: set default\` - after a deploy succeeds, sets the deploy as default
  - \`sun: abort\` - abort a deploy (at any point during the process)
  - \`sun: finish\` - do the last step in deploy, to merge with master and let the next person deploy
  - \`sun: emergency rollback\` - roll back the production site outside of the deploy process
  - \`sun: cc @<username> [+ <username> ...]\` - CC user(s) so they get notified during the current deploy
`;

const emoji_help_text = `:speech_balloon:
  :sun::question: help
  :sun::heavy_plus_sign: queue
  :sun::fast_forward: next
  :sun::x: remove
  :sun::test-tube: test
  :sun::amphora: history
  :sun::treeeee: deploy
  :sun::rocket: set default
  :sun::skull: abort
  :sun::party_dino: finish
  :sun::scream: emergency rollback
`;

// The room to listen to deployment commands in.  For safety reasons, sun
// will only listen in this room by default.  This should be a slack
// channel ID, because the API we're using to send doesn't support linking to a
// room by name.  You can get the list of our channels, including their IDs, at
// https://api.slack.com/methods/channels.list/test; we could probably call
// this dynamically, but for now, hard-coding it is easier.  The default is
// #bot-testing.
// TODO(benkraft): if Slack ever fixes this issue, switch to using the room
// name for readability.
const DEPLOYMENT_ROOM_ID = process.env.DEPLOY_ROOM_ID || "C090KRE5P";

// Whether to run in DEBUG mode.  In DEBUG mode, sun will not
// actually post commands to Jenkins, nor will it only honor Jenkins
// state commands that come from the actual Jenkins, allowing for
// easier debugging
const DEBUG = !!process.env.SUN_DEBUG;

// deployer | [deployer1, deployer2] | optional extra message
const TOPIC_REGEX = /^([^|]*) ?\| ?\[([^\]]*)\](.*)$/;
// person1 + person2 + person3 (optional notes on deploy)
const DEPLOYER_REGEX = /^([^(]*)(?:\((.*)\))?$/;
// Any number of hyphens, en dashes, and em dashes.
const NO_DEPLOYER_REGEX = /^[-–—]*$/;

// Internal field separator
// TODO(drosile): Use the field separator to split out commands and arguments
// so we can have simpler, more legible regular expressions. Alternatively,
// we could look into using an option-parsing library
const FIELD_SEP = ',';

// CSRF token used to submit Jenkins POST requests - in Jenkins-land, this is
// referred to as a "crumb". This value is retrieved when the first Jenkins
// POST is made, and stored throughout the lifetime of this instance since
// Jenkins CSRF tokens apparently do not expire.
let JENKINS_CSRF_TOKEN = null;

// User list for the bot to CC on deploy messages. This gets reset by
// handleSafeDeploy, and can be added to as part of initiating the deploy
// or with the `cc` command
// TODO(drosile): Figure out a way to avoid the statefulness implied by this,
// or at least to minimize its effects.
// TODO(drosile): Apply the CC list only to specific actions. Currently it will
// CC the list for any action, even if it is unrelated to the current deploy.
let CC_USERS = [];

// Email addresses of users authorized to deploy. Set by parseIAMPolicy().
let VALID_DEPLOYER_EMAILS = new Set();
// Maps slack user ids to email addresses.
const USER_EMAILS = new Map();

//--------------------------------------------------------------------------
// Utility code
//--------------------------------------------------------------------------

/**
 * An error that will be reported back to the user.
 */
class SunError {
    constructor(msg) {
        this.message = msg;
        this.name = "SunError";
    }
}


/**
 * Generates a Slack message blob, without sending it, with everything
 * prepopulated. Useful for when you need to return a message to slack through
 * some mechanism other than replyAsSun (e.g., as a response to an outgoing
 * webhook).
 *
 * @param msg the *incoming* hook data from Slack, as handled in the main
 *   route method
 * @param reply The text you want embedded in the message
 */
function sunMessage(msg, reply) {
    let message_text = `@${msg.user} `;
    if (CC_USERS.length != 0) {
      message_text += `(cc ${CC_USERS.join(', ')}) `;
    }
    message_text += reply;
    return {
        username: "Sun Wukong",
        icon_emoji: ":monkey_face:",
        channel: msg.channel,
        text: message_text,
        link_names: true
    };
}


/**
 * Reply as sun, immediately sending a response
 * @param msg the *incoming* message hook data from Slack
 * @param reply the text you want to send as the reply
 */
function replyAsSun(msg, reply) {
    if (DEBUG) {
        console.log(`Sending: "${reply}"`);
    }
    // TODO(benkraft): more usefully handle any errors we get from this.
    // Except it's not clear what to do if posting to slack fails.
    slackAPI("chat.postMessage", sunMessage(msg, reply)).catch(console.error);
}


/**
 * Try to write a useful log for various types of HTTP errors.
 *
 * err should be the exception or an HTTP response.  body should be the decoded
 * response body, if there is one.
 *
 * This only logs the error; after calling it you should throw a SunError with
 * a user-friendly message.
 */
function logHttpError(err, body) {
    console.error("HTTP Error");
    console.error(`    Error: ${JSON.stringify(err)}`);
    if (err.stack) {
        console.error(`    Stack: ${err.stack}`);
    }
    if (err.statusCode) {
        console.error(`    Status: ${err.statusCode}`);
    }
    if (err.headers) {
        const headers = JSON.stringify(err.headers);
        console.error(`    Headers: ${headers}`);
    }
    if (body) {
        console.error(`    Body: ${body}`);
    }
}


/**
 * Report an error back to the user.
 *
 * If it's a SunError, or otherwise has a `message` attribute, just use that;
 * otherwise send a general failure message.  If the thrower can log anything
 * about the error, they should, since they have more information about what's
 * going on and why.  Either way, we'll try our best to log it too.
 */
function onError(msg, err) {
    console.error("ERROR");
    console.error(`    Error: ${JSON.stringify(err)}`);
    if (err.stack) {
        console.error(`    Stack: ${err.stack}`);
    }
    let errorMessage;
    if (err.message) {
        errorMessage = err.message;
    } else {
        errorMessage = ("Something went wrong and I won't know what to " +
                        "do!  Try doing things yourself, or check my " +
                        "logs.");
    }
    // The error message may come after another message.  Wait a second to
    // encourage slack to put the messages in the right order.
    setTimeout(() => replyAsSun(msg, errorMessage), 1000);
}

/**
 * Get a promise for the [response, body] of a request-style options object
 *
 * A URL may be passed as the options object in the case of a GET request.
 * On error, rejects with the error, and logs it, but does not report back to
 * the user.
 */
function requestQ(options) {
    const deferred = Q.defer();
    request(options, (err, resp, body) => {
        if (err) {
            logHttpError(err, body);
            deferred.reject(err);
        } else {
            deferred.resolve([resp, body]);
        }
    });
    return deferred.promise;
}

/**
 * Get a promise for the body of a 200 response
 *
 * On a non-200 response, rejects with the response and logs the error.
 * Otherwise like requestQ.
 */
function request200(options) {
    return requestQ(options).spread((resp, body) => {
        if (resp.statusCode > 299) {
            logHttpError(resp, body);
            // Q will catch this and reject the promise
            throw resp;
        } else {
            return body;
        }
    });
}

/**
 * Make a request to the given Slack API call with the given params object
 *
 * Returns a promise for an object (decoded from the response JSON).
 */
function slackAPI(call, params) {
    params.token = process.env.SLACK_BOT_TOKEN;
    const options = {
        url: `https://slack.com/api/${call}`,
        // Slack always accepts both GET and POST, but using GET for things
        // that modify data is questionable.
        method: "POST",
        form: params,
    };
    return request200(options).then(JSON.parse).then(data => {
        if (!data.ok) {
            throw new SunError("Slack won't listen to me!  " +
                               `It said \`${data.error}\` when I tried to ` +
                               `\`${call}\`.`);
        }
        return data;
    });
}

/**
 * Parse a list of users and add them to the CC_USERS variable for notification
 * of deploys.
 * TODO(drosile): uniq and/or validate CC_USERS as they are added
 */
function addUsersToCCList(users_str) {
  users_str.split(/\s*\+\s*/)
    .map(username => username.startsWith('@') ? username : `@${username}`)
    .map(username => CC_USERS.push(username));
}

//--------------------------------------------------------------------------
// Developer email validation
//--------------------------------------------------------------------------

function getUserEmails() {
    return slackAPI("users.list", {}).then(data => {
        for (let i in data.members) {
            const member = data.members[i];
            USER_EMAILS.set(member.id, member.profile.email);
        }
        return "ok";
    });
}

/**
 * Returns a promise that resolves to a boolean. Check if an email is authorized
 * to deploy.
 */
function isFulltimeDev(userId) {
    let email = USER_EMAILS.get(userId);
    const promises = [];
    if (email === undefined) {
        // Maybe a new user, reload slack emails.
        promises.push(getUserEmails());
        console.error("Refetching emails, missing " + userId);
    }
    if (VALID_DEPLOYER_EMAILS.size === 0 || !VALID_DEPLOYER_EMAILS.has(email)) {
        // Try to load authorized emails.
        promises.push(getIAMPolicy());
        console.error("Refetching authorized emails, missing " + email);
    }
    return Q.all(promises).then(() => {
        email = USER_EMAILS.get(userId);
        return VALID_DEPLOYER_EMAILS.has(email);
    });
}

//--------------------------------------------------------------------------
// Talking to GCP
//--------------------------------------------------------------------------

/**
 * Authorize with GCP using JWT secret and fetch the khan-academy IAM policy.
 * Returns a promise.
 */
function getIAMPolicy() {
    const deferred = Q.defer();
    let cloudresourcemanager = googleapis.cloudresourcemanager("v1");

    let jwtClient = new googleapis.auth.JWT(
        googleKey.client_email,
        null,
        googleKey.private_key,
        ["https://www.googleapis.com/auth/cloudplatformprojects.readonly"],
        null
    );

    jwtClient.authorize((err, tokens) => {
        if (err) {
            deferred.reject(err);
            return;
        }

        // https://cloud.google.com/resource-manager/reference/rest/v1/projects/getIamPolicy
        const request = {
            resource_: "khan-academy",
            resource: {},
            auth: jwtClient
        };
        cloudresourcemanager.projects.getIamPolicy(request, (err, result) => {
            if (err) {
                deferred.reject(err);
                return;
            }
            parseIAMPolicy(result);
            deferred.resolve();
        });
    });
    return deferred.promise;
}

/**
 * Parse the IAM policy and set VALID_DEPLOYER_EMAILS based on all the users who
 * have either the Editor or the Owner role in the project.
 */
function parseIAMPolicy(result) {
    const emails = new Set();
    const devRoles = ["roles/editor", "roles/owner"];
    for (let i in result.bindings) {
        const users = result.bindings[i];
        if (devRoles.indexOf(users.role) !== -1) {
            for (let j in users.members) {
                const member = users.members[j];
                if (member.indexOf(":") == -1) {
                    // Ignore members who aren't of the format type:id.
                    continue;
                }
                const parts = member.split(":", 2);
                const memberType = parts[0];
                if (memberType !== "user") {
                    continue;
                }
                emails.add(parts[1]);
            }
        }
    }
    VALID_DEPLOYER_EMAILS = emails;
}


//--------------------------------------------------------------------------
// Talking to Jenkins
//--------------------------------------------------------------------------

function getJenkinsCSRFToken() {
    return requestQ({
        url: ("https://jenkins.khanacademy.org/crumbIssuer/api/json"),
        auth: {
            username: "jenkins@khanacademy.org",
            password: process.env.JENKINS_API_TOKEN,
        },
    }).spread((res, body) => {
        const data = JSON.parse(body);
        if (data.crumb === undefined) {
            console.error("Operation aborted. Found no crumb data at " +
                "/crumbIssuer/api/json. Maybe Jenkins CSRF protection has " +
                "been turned off?");
            throw new SunError(
                "Operation aborted due to problems acquiring a CSRF token");
        } else {
            JENKINS_CSRF_TOKEN = data.crumb;
        }
    }).catch(err => {
        console.error("Operation aborted. Encountered the following error " +
            "when trying to reach /crumbIssuer/api/json: " + err);
        throw new SunError(
            "Operation aborted due to problems acquiring a CSRF token");
    });
}

// path should be the URL path; postData should be an object which we will
// encode.  If allowRedirect is falsy, we will consider a 3xx response an
// error.  If allowRedirect is truthy, we will consider a 3xx response a
// success.  (This is because a 302, for instance, might mean that we need to
// follow a redirect to do the thing we want, or it might mean that we were
// successful and are now getting redirected to a new page.)
function getOrPostToJenkins(path, postData, allowRedirect) {
    const options = {
        url: "https://jenkins.khanacademy.org" + path,
        method: "GET",
        auth: {
            username: "jenkins@khanacademy.org",
            password: process.env.JENKINS_API_TOKEN,
        },
    };
    if (postData !== null) {
        options.method = "POST";
        postData['Jenkins-Crumb'] = JENKINS_CSRF_TOKEN;
        options.form = postData;
    }

    if (DEBUG) {
        console.log(options);
        return Q('');       // a promise resolving to the empty string
    }

    return requestQ(options).spread((res, body) => {
        if ((!allowRedirect && res.statusCode > 299) || res.statusCode > 399) {
            logHttpError(res, body);
            throw res;
        }
        return body;
    }).catch(_err => {
        // Replace the error (which has already been logged) with a more
        // user-friendly one.
        throw new SunError("Jenkins won't listen to me!  You'll have to " +
                           "talk to it yourself.");
    });
}

function runOnJenkins(msg, path, postData, message, allowRedirect) {
    // Tell readers what we're doing.
    if (message) {
        replyAsSun(msg, (DEBUG ? "DEBUG :: " : "") + message);
    }

    // If we haven't yet grabbed a CSRF token (needed for POST requests), then
    // grab one before making our request.
    if (!JENKINS_CSRF_TOKEN) {
        getJenkinsCSRFToken().then(body => {
            getOrPostToJenkins(path, postData, allowRedirect);
        });
    } else {
        getOrPostToJenkins(path, postData, allowRedirect);
    }
}

/**
 * Return the path of a url that points to the given job.
 *
 * jobName can be like "deploy/test" if the job is in a folder.
 */
function jobPath(jobName) {
    // So deploy/test expands to deploy/job/test
    let jobUrlPart = jobName.split('/').join('/job/');
    return "/job/" + jobUrlPart;
}


/**
 * Returns a promise for the current job ID if one is running, or false if not.
 */
function jenkinsJobStatus(jobName) {
    return request200({
        url: ("https://jenkins.khanacademy.org" +
              `${jobPath(jobName)}/lastBuild/api/json`),
        auth: {
            username: "jenkins@khanacademy.org",
            password: process.env.JENKINS_API_TOKEN,
        },
    }).then(body => {
        const data = JSON.parse(body);
        if (data.building === undefined ||
                (data.building && !data.number)) {
            console.error("No build status found!");
            console.error(`    API response: ${body}`);
            throw body;
        } else if (data.building) {
            return data.number;
        } else {
            return null;
        }
    }).catch(_err => {
        // Replace the error (which has already been logged) with a more
        // user-friendly one.
        throw new SunError("Jenkins won't tell me what's running!  " +
                           "You'll have to talk to it yourself.");
    });
}

// postData is an object, which we will encode and post to either
// /job/<job>/build or /job/<job>/buildWithParameters, as appropriate.
function runJobOnJenkins(msg, jobName, postData, message) {
    let path;
    if (Object.keys(postData).length === 0) {  // no parameters
        path = `${jobPath(jobName)}/build`;
    } else {
        path = `${jobPath(jobName)}/buildWithParameters`;
    }

    runOnJenkins(msg, path, postData, message);
}


function cancelJobOnJenkins(msg, jobName, jobId, message) {
    const path = `${jobPath(jobName)}/${jobId}/stop`;
    runOnJenkins(msg, path, {}, message, true);
}


//--------------------------------------------------------------------------
// Slack: deploy queue
//--------------------------------------------------------------------------

/**
 * Obfuscate a username so it won't generate an at-mention
 *
 * Every time a room topic gets updated, everyone listed in the topic gets an
 * at-mention.  That's kind of annoying, so we stick zero-width spaces in
 * the usernames to avoid it.
 *
 * @param string username The username
 *
 * @return string The username, but with less at-mention.
 */
function obfuscateUsername(username) {
    // We use U+200C ZERO-WIDTH NON-JOINER because it doesn't count as a
    // word-break, making it easier to still highlight and delete your whole
    // name.
    return `${username[0]}\u200c${username.slice(1)}`;
}

/**
 * Unobfuscate a username
 *
 * Undo the transformation done by obfuscateUsername.
 *
 * @param string username The username
 *
 * @return string The username, but with more at-mention.
 */
function unobfuscateUsername(username) {
    return username.replace("\u200c", "");
}

/**
 * Parse a deployer from the topic into an object.
 *
 * @param string deployerString The deployer string to be parsed.
 *
 * @return {?string|{usernames: Array.<string>, note: (undefined|string)}} The
 *     parsed deployer.  null if there is no deployer (i.e. an empty string or
 *     series of dashes.  A string if we couldn't parse the deployer.  An
 *     object if we could.
 */
function parseDeployer(deployerString) {
    const trimmed = deployerString.trim();
    if (!trimmed || trimmed.match(NO_DEPLOYER_REGEX)) {
        return null;
    }
    const matches = trimmed.match(DEPLOYER_REGEX);
    if (!matches) {
        return trimmed;
    }
    return {
        usernames: matches[1].split("+")
            .map(username => unobfuscateUsername(username.trim())),
        note: matches[2],
    };
}

/**
 * Turn a deployer object back into a string.
 *
 * @param {?string|{usernames: Array.<string>, note: (undefined|string)}}
 *     deployer A deployer such as that returned by parseDeployer.
 *
 * @return string
 */
function stringifyDeployer(deployer) {
    if (!deployer) {
        // an em dash
        return "—";
    } else if (!deployer.usernames) {
        return deployer;
    } else {
        let suffix = "";
        if (deployer.note) {
            suffix = ` (${deployer.note})`;
        }
        const listOfUsernames = deployer.usernames
            .map(obfuscateUsername)
            .join(" + ");
        return listOfUsernames + suffix;
    }
}

/**
 * Turn a deploy object into a string useful for notifying all deployers.
 * For instance, a return value might be "@csilves @amy".
 *
 * @param {?string|{usernames: Array.<string>, note: (undefined|string)}}
 *     deployer A deployer such as that returned by parseDeployer.
 *
 * @return string
 */
function stringifyDeployerUsernames(deployer) {
    // deployer will be either an object with a username key, or a
    // string which we couldn't parse.
    if (deployer.usernames) {
        return deployer.usernames.map(username => `@${username}`).join(" ");
    } else {
        return deployer;
    }
}

/**
 * Get a promise for the parsed topic of the deployment room.
 *
 * The promise will resolve to an object with keys "deployer" (a deployer (as
 * output by parseDeployer), or null if no one is deploying), "queue" (an array
 * of deployers), and "suffix" (a string to be appended to the end of the
 * queue, such as an extra message), if Sun can parse the topic.
 *
 * Rejects the promise if the API request fails or if it can't understand the
 * topic, and replies with a message to say so.
 */
function getTopic(_msg) {
    const params = {channel: DEPLOYMENT_ROOM_ID};
    return slackAPI("channels.info", params).then(info => {
        let topic = info.channel.topic.value;
        // Slack for some reason escapes &, <, and > using HTML escapes, which
        // is just plain incorrect, but we'll handle it.  Since these seem to
        // be the only escapes it uses, we won't bother to do something
        // fancier.
        topic = topic.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&");
        const matches = topic.match(TOPIC_REGEX);
        if (!matches) {
            console.error(`Error parsing topic: ${topic}`);
            throw new SunError(":confounded: I can't understand the topic.  " +
                               "You'll have to do it yourself.");
        } else {
            const people = matches[2]
                .split(",")
                .map(parseDeployer)
                .filter(person => person);
            const topicObj = {
                deployer: parseDeployer(matches[1]),
                queue: people,
                suffix: matches[3],
            };
            return topicObj;
        }
    });
}

/**
 * Set the topic of the deployment room.
 *
 * Accepts a topic of the form returned by getTopic().  If setting the topic
 * fails, replies to Slack to say so.
 *
 * Returns a promise for being done.
 */
function setTopic(msg, topic) {
    const listOfPeople = topic.queue.map(stringifyDeployer).join(", ");
    const deployer = stringifyDeployer(topic.deployer);
    const newTopic = `${deployer} | [${listOfPeople}]${topic.suffix}`;
    return slackAPI("channels.setTopic", {
        channel: DEPLOYMENT_ROOM_ID,
        topic: newTopic,
    });
}


//--------------------------------------------------------------------------
// Slack: sun wukong the monkey king
//--------------------------------------------------------------------------

/**
 * Return a promise that resolves to whether the pipeline step is valid.
 */
function validatePipelineStep(step, deployWebappId) {
    let expectedName = null;
    if (step === "set-default-start") {
        // The "/input" form is where you click to proceed or abort.
        // The 'proceed' button has the following name on it.
        expectedName = "SetDefault";
    } else if (step == "finish-with-success") {
        expectedName = "Finish";
    }

    if (!expectedName) {
        return Q(false);     // not a step we were expecting to see next!
    }
    if (!deployWebappId) {
        return Q(false);     // a deploy isn't even running now!
    }

    const path = `${jobPath("deploy/deploy-webapp")}/${deployWebappId}/input/`;
    return getOrPostToJenkins(path, null, false).then(body => {
        return body.indexOf(`name="${expectedName}"`) !== -1;
    }).catch(_err => {  // 404: no inputs expected right now at all
        return false;
    });
}

function wrongPipelineStep(msg, badStep) {
    replyAsSun(msg, `:hal9000: I'm sorry, @${msg.user}.  I'm ` +
        "afraid I can't let you do that.  (It's not time to " +
        `${badStep}.  If you disagree, bring it up with Jenkins.)`);
}

function validateUserAuth(msg) {
    return isFulltimeDev(msg.user_id).then(result => {
        if (result) {
            return "ok";
        } else {
            throw new SunError(
                ":hal9000: You must be a fulltime developer to " +
                "do that. Ask <#C0BBDFJ7M|it> to make " +
                "sure you have the correct GCP roles. " +
                "It's always possible to use Jenkins to deploy if you " +
                "are getting this message in error.");
        }
    });
}

function handleHelp(msg) {
    replyAsSun(msg, help_text);
}

function handleEmojiHelp(msg) {
    replyAsSun(msg, emoji_help_text);
}

function handlePing(msg) {
    replyAsSun(msg, "I AM THE MONKEY KING!");
}

function handleFingersCrossed(msg) {
    replyAsSun(msg, "Okay, I've crossed my fingers.  :fingerscrossed:");
}

function handleState(msg) {
    jenkinsJobStatus("deploy/deploy-webapp").then(deployWebappId => {
        let text;
        if (deployWebappId) {
            text = `deploy/deploy-webapp #${deployWebappId} is currently running.`;
        } else {
            text = "No deploy is currently running.";
        }
        replyAsSun(msg, text);
    });
}

function handlePodBayDoors(msg) {
    wrongPipelineStep(msg, "open the pod bay doors");
}

function handleQueueMe(msg) {
    return validateUserAuth(msg).then(() => {
        let user = msg.user;
        const arg = msg.match[1].trim();
        if (arg && arg !== "me") {
            user = arg;
        }
        return getTopic(msg).then(topic => {
            if (topic.queue.length === 0 && topic.deployer === null) {
                topic.deployer = user;
                return setTopic(msg, topic);
            } else {
                topic.queue.push(obfuscateUsername(user));
                return setTopic(msg, topic);
            }
        });
    });
}

function doQueueNext(msg) {
    return getTopic(msg).then(topic => {
        const newDeployer = topic.queue[0];
        const newTopic = {
            deployer: newDeployer,
            queue: topic.queue.slice(1),
            suffix: topic.suffix
        };
        // Wait for the topic change to complete, then pass down the new
        // deployer.
        return setTopic(msg, newTopic).then(_ => newDeployer);
    }).then(newDeployer => {
        if (!newDeployer) {
            replyAsSun(msg, "Okay.  Anybody else want to deploy?");
        } else {
            const mentions = stringifyDeployerUsernames(newDeployer);
            replyAsSun(msg, `Okay, ${mentions} it is your turn!`);
        }
    });
}

function handleQueueNext(msg) {
    // TODO(csilvers): complain if they do 'next' after the happy dance,
    // since we do that automatically now.
    doQueueNext(msg);
}


function handleRemoveMe(msg) {
    let user = msg.user;
    const arg = msg.match[1].trim();
    if (arg && arg !== "me") {
        user = arg;
    }
    return getTopic(msg).then(topic => {
        topic.queue = topic.queue.filter(
            deploy => !deploy.usernames.includes(user));
        // TODO(benkraft): if the removed user is deploying, do an `up next` as
        // well.
        return setTopic(msg, topic);
    });
}

function handleCCUsers(msg) {
    jenkinsJobStatus("deploy/deploy-webapp").then(deployWebappId => {
        if (deployWebappId) {
            let ccUsers = msg.match[1];
            addUsersToCCList(ccUsers);
            replyAsSun(msg, "Okay, I've added them to the notification list for this deploy.");
        } else {
            replyAsSun(msg, "It doesn't look like there is any deploy going on.");
        }
        return;
    });
}


function handleDeleteZnd(msg) {
    const znd_name = msg.match[1].trim();
    const responseText = "Okay, I'll ask Jenkins to delete that ZND!";
    const postData = {
        "ZND_NAME": znd_name,
    };
    runJobOnJenkins(msg, "deploy/delete-znd", postData, responseText);
}


function handleNotifyZndOwners(msg) {
    const responseText = ("Okay, I'll check in with ZND owners about " +
                          "cleaning up their ZNDs");
    runJobOnJenkins(msg, "deploy/notify-znd-owners", {}, responseText);
}


function handleHistory(msg) {
    const responseText = (
        "Asking jenkins to print the changelog for the last 5 deploys. " +
        "(This may take a minute.)");
    runJobOnJenkins(msg, "deploy/deploy-history",
                    {"SLACK_CHANNEL": msg.channel}, responseText);
}


function handleMakeCheck(msg) {
    const deployBranch = msg.match[1];
    const postData = {
        "GIT_REVISION": deployBranch,
        "SLACK_CHANNEL": msg.channel,
        "REPORT_RESULT": true,
    };
    let responseText = ("Telling Jenkins to run tests on branch `" +
                        deployBranch + "`.");
    runJobOnJenkins(msg, "deploy/webapp-test", postData, responseText);
}

function handleDeploy(msg) {
    // Check that it's not Friday
    const d = new Date();
    // Adjust for time zone (UTC)
    // If (d.getHours() - 7) is negative, d moves back a day
    d.setHours(d.getHours() - 7);
    if (d.getDay() === 5) {
        replyAsSun(msg,
            ":frog: It's Friday! Please don't make changes that potentially " + 
            "affect many parts of the site. If your change affects only " + 
            "a small surface area that you can verify manually, go " + 
            "forth and deploy with `sun: deploy-not-risky [branch-name]`");
        return Promise.resolve();
    } else {
        return handleSafeDeploy(msg);
    }
}

function handleSafeDeploy(msg) {
    return validateUserAuth(msg).then(() => {
        const deployBranch = msg.match[1];
        const ccUsers = msg.match[2];

        jenkinsJobStatus("deploy/deploy-webapp").then(deployWebappId => {
            if (deployWebappId) {
                replyAsSun(msg, "I think there's a deploy already going on. " +
                    "If that's not the case, take it up with Jenkins.");
                return false;
            }

            CC_USERS = [];
            if (!!ccUsers) {
              addUsersToCCList(ccUsers);
            }
            const caller = msg.user;
            const postData = {
                "GIT_REVISION": deployBranch,
                "DEPLOYER_USERNAME": "@" + caller
            };

            runJobOnJenkins(msg, "deploy/deploy-webapp", postData,
                "Telling Jenkins to deploy branch `" + deployBranch + "`.");
            return true;
        }).then(startedDeploy => {
            if (startedDeploy) {
                getTopic(msg).then(topic => {
                    if (topic.queue.length > 0) {
                        const mentions = stringifyDeployerUsernames(topic.queue[0]);
                        replyAsSun(msg, `${mentions}, now would be ` +
                                   "a good time to run `sun: test master + " +
                                   deployBranch + " + <your branch>`");
                    }
                });
            }
        });
    });
}

function handleSetDefault(msg) {
    return validateUserAuth(msg).then(() => {
        jenkinsJobStatus("deploy/deploy-webapp").then(deployWebappId => {
            validatePipelineStep("set-default-start", deployWebappId).then(isValid => {
                if (!isValid) {
                    return wrongPipelineStep(msg, "set-default");
                }
                // Hit the "continue" button.
                replyAsSun(msg, (DEBUG ? "DEBUG :: " : "") +
                           "Telling Jenkins to set default");
                const path = `${jobPath("deploy/deploy-webapp")}/${deployWebappId}/input/SetDefault/proceedEmpty`;
                runOnJenkins(null, path, {}, null, false);
            });
        });
    });
}

function handleAbort(msg) {
    jenkinsJobStatus("deploy/deploy-webapp").then(deployWebappId => {
        if (deployWebappId) {
            // There's a job running, so we should probably cancel it.
            cancelJobOnJenkins(msg, "deploy/deploy-webapp",
                deployWebappId,
                "Telling Jenkins to cancel deploy/deploy-webapp " +
                "#" + deployWebappId + ".");
            CC_USERS = [];
        } else {
            // If no deploy is in progress, we had better not abort.
            replyAsSun(msg,
                "I don't think there's a deploy going.  If you need " +
                "to roll back the production servers because you noticed " +
                "some problems after a deploy finished, :speech_balloon: " +
                "_“sun: emergency rollback”_.  If you think there's a " +
                "deploy going, then I'm confused and you'll have to talk " +
                "to Jenkins yourself.");
        }
    });
}

function handleFinish(msg) {
    jenkinsJobStatus("deploy/deploy-webapp").then(deployWebappId => {
        validatePipelineStep("finish-with-success", deployWebappId).then(isValid => {
            if (!isValid) {
                return wrongPipelineStep(msg, "finish-with-success");
            }
            // Hit the "continue" button.
            replyAsSun(msg, (DEBUG ? "DEBUG :: " : "") +
                       "Telling Jenkins to finish this deploy!");
            CC_USERS = [];
            const path = `${jobPath("deploy/deploy-webapp")}/${deployWebappId}/input/Finish/proceedEmpty`;
            runOnJenkins(null, path, {}, null, false);
            // wait a little while before notifying the next person.
            // hopefully the happy dance has appeared by then, if not
            // humans will have to figure it out themselves.
            setTimeout(() => doQueueNext(msg), 20000);
        });
    });
}

function handleEmergencyRollback(msg) {
    const jobname = "deploy/---EMERGENCY-ROLLBACK---";
    runJobOnJenkins(msg, jobname, {},
        "Telling Jenkins to roll back the live site to a safe " +
        "version");
}

const textHandlerMap = new Map([
    // Get help
    [/^help$/i, handleHelp],
    // Return ping and verify you're in the right room
    [/^ping$/i, handlePing],
    // Return the dump of the JSON state
    [/^(cross (your )?fingers|fingers crossed).*$/i, handleFingersCrossed],
    // Return the dump of the JSON state
    [/^state$/i, handleState],
    // Attempt to open the pod bay doors
    [/^open the pod bay doors/i, handlePodBayDoors],
    // Add the sender to the deploy queue
    [/^(?:en)?queue\s*(.*)$/i, handleQueueMe],
    // Move on to the next deployer
    [/^(?:up )?next/i, handleQueueNext],
    // Remove the sender from the deploy queue
    [/^(?:remove|dequeue)\s*(.*)$/i, handleRemoveMe],
    // Run tests on a branch outside the deploy process
    [new RegExp("^test\\s+(?:branch\\s+)?([^" + FIELD_SEP + "]*)$", 'i'), handleMakeCheck],
    // Delete a given znd
    [new RegExp("^delete(?: znd)?\\s+(?:znd\\s+)?([^" + FIELD_SEP + "]*)$", 'i'), handleDeleteZnd],
    // Begin the deployment process for the specified branch
    [/^prompt znd cleanup$/i, handleNotifyZndOwners],
    // Print recent deploy history
    [/^history$/i, handleHistory],
    // Begin the deployment process for the specified branch (if not Friday)
    [new RegExp("^deploy\\s+(?:branch\\s+)?([^" + FIELD_SEP + "]*)(?:,(?:\\s+)?cc(?:[\\s:]+)([^" + FIELD_SEP + "]+))?$", 'i'),
     handleDeploy],
    // Begin the deployment process for the (non-risky) branch
    [new RegExp("^deploy-not-risky\\s+(?:branch\\s+)?([^" + FIELD_SEP + "]*)(?:,(?:\\s+)?cc(?:[\\s:]+)([^" + FIELD_SEP + "]+))?$", 'i'),
     handleSafeDeploy],
    // Set the branch in testing to the default branch
    [/^set.default$/i, handleSetDefault],
    // Abort the current deployment step
    [/^abort.*$/i, handleAbort],
    // Mark the version currently testing as default as good and mark the
    // deploy as done
    [/^finish.*$/i, handleFinish],
    [/^yolo.*$/i, handleFinish],
    // Roll back production to the previous version after set default
    [/^emergency rollback.*$/i, handleEmergencyRollback],
    // CC users on the current deploy (they will be at-mentioned in further messages)
    [new RegExp("^cc\\s+([^" + FIELD_SEP + "]*)$", 'i'), handleCCUsers],
    // Catch-all: if we didn't get a valid command, send the help message.
    [/^.*$/i, handleHelp],
]);

const emojiHandlerMap = new Map([
    [/^:(?:question|grey_question):/i, handleEmojiHelp],
    [/^:point_left:/i, handlePing],
    [/^:fingerscrossed:/i, handleFingersCrossed],
    [/^:shrug:/i, handleState],
    [/^:hal9000:/i, handlePodBayDoors],
    [/^:(?:plus1|heavy_plus_sign):\s*(.*)$/i, handleQueueMe],
    [/^:(?:arrow_right|arrow_forward|fast_forward):/i, handleQueueNext],
    [/^:(?:x|negative_squared_cross_mark|heavy_multiplication_x):\s*(.*)$/i,
     handleRemoveMe],
    [new RegExp("^:(?:test-tube|100):\\s*([^" + FIELD_SEP + "]*)", 'i'), handleMakeCheck],
    [/^:amphora:/i, handleHistory],
    [new RegExp("^:(?:ship|shipit|passenger_ship|pirate_ship|treeeee):\\s*([^" + FIELD_SEP + "]*)", 'i'),
     handleDeploy],
    [new RegExp("^:confidence-high:\\s*([^" + FIELD_SEP + "]*)", 'i'),
     handleSafeDeploy],
    [/^:rocket:/i, handleSetDefault],
    [/^:(?:skull|skull_and_crossbones|sad_mac|sadpanda|party_parrot_sad):/i,
     handleAbort],
    [/^:(?:cry|disappointed):/i, handleAbort],
    [/^:(?:yolo|party_dino|ballot_box_with_check|checkered_flag):/i,
     handleFinish],
    [/^:(?:heavy_check_mark|white_check_mark):/i, handleFinish],
    [/^:scream:/i, handleEmergencyRollback],
    [new RegExp("^:phone:\\s+([^" + FIELD_SEP + "]*)$", 'i'), handleCCUsers],
    [/^.*$/i, handleEmojiHelp],
]);

const app = express();
app.use(bodyParser.urlencoded({extended: true}));
app.post("/", (req, res) => {
    if (req.body.token !== process.env.SLACK_VERIFICATION_TOKEN) {
        res.status(401).send("You appear to be unauthorized.");
        return;
    }
    const message = {
        channel: "#" + req.body.channel_name,
        channel_id: req.body.channel_id,
        user: req.body.user_name,
        user_id: req.body.user_id,
        text: req.body.text.substring(req.body.trigger_word.length).trimLeft()
    };
    if (message.channel_id !== DEPLOYMENT_ROOM_ID) {
        res.json(sunMessage(
            message,
            `Sorry, I only respond to messages in <#${DEPLOYMENT_ROOM_ID}>!`));
        return;
    }
    const handlerMap = (req.body.trigger_word[0] === ':' ?
                        emojiHandlerMap : textHandlerMap);
    for (let [rx, fn] of handlerMap) {
        const match = rx.exec(message.text);
        if (match !== null) {
            message.match = match;
            Q(fn(message))
            .catch(err => onError(message, err))
            .then(() => res.send({}));
            break;
        }
    }
});


const server = app.listen(process.env.PORT || "8080", "0.0.0.0", () => {
    console.log("App listening at https://%s:%s",
        server.address().address, server.address().port);
    console.log("Press Ctrl-C to quit.");
});
