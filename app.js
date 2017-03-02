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
 */

const help_text = `*Commands*
  - \`sun: help\` - show the help text
  - \`sun: queue [user]\` - add someone to the deploy queue (user is "me" or of the form \`user1 + user2 (optional note)\`)
  - \`sun: up next\` - move the person at the front of the queue to deploying, and ping them
  - \`sun: remove [user]\` - remove someone from the deploy queue (user is "me" or a username)
  - \`sun: test [branch name]\` - run tests on a particular branch, independent of a deploy
  - \`sun: delete znd [znd name]\` - ask Jenkins to delete the given znd
  - \`sun: prompt znd cleanup\` - check in with znd owners about cleaning up their znd
  - \`sun: deploy [branch name]\` - deploy a particular branch to production
  - \`sun: set default\` - after a deploy succeeds, sets the deploy as default
  - \`sun: abort\` - abort a deploy (at any point during the process)
  - \`sun: finish\` - do the last step in deploy, to merge with master and let the next person deploy
  - \`sun: emergency rollback\` - roll back the production site outside of the deploy process
`;

const emoji_help_text = `:speech_balloon:
  :sun::question: help
  :sun::heavy_plus_sign: queue
  :sun::fast_forward: next
  :sun::x: remove
  :sun::test-tube: test
  :sun::treeeee: deploy
  :sun::rocket: set default
  :sun::skull: abort
  :sun::party_dino: finish
  :sun::scream: emergency rollback
`;

import express from "express";
import bodyParser from "body-parser";
import Q from "q";
import request from "request";

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


// CSRF token used to submit Jenkins POST requests - in Jenkins-land, this is
// referred to as a "crumb". This value is retrieved when the first Jenkins
// POST is made, and stored throughout the lifetime of this instance since
// Jenkins CSRF tokens apparently do not expire.
let JENKINS_CSRF_TOKEN = null;


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
    return {
        username: "Sun Wukong",
        icon_emoji: ":monkey_face:",
        channel: msg.channel,
        text: `<@${msg.user}> ${reply}`
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
    console.error(`    Error: ${err}`);
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
    console.error(`    Error: ${err}`);
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
    // encourage to put the messages in the right order.
    setTimeout(() => replyAsSun(msg, errorMessage), 1000);
}

/**
 * Return whether the proposed step is valid.
 */
function pipelineStepIsValid(deployState, step) {
    return (deployState.POSSIBLE_NEXT_STEPS &&
            (deployState.POSSIBLE_NEXT_STEPS.indexOf(step) !== -1 ||
             deployState.POSSIBLE_NEXT_STEPS.indexOf('<all>') !== -1));
}

function wrongPipelineStep(msg, badStep) {
    replyAsSun(msg, `:hal9000: I'm sorry, @${msg.user}.  I'm ` +
        "afraid I can't let you do that.  (It's not time to " +
        `${badStep}.  If you disagree, bring it up with Jenkins.)`);
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
 * Get the current state of the deploy from Jenkins.
 *
 * Returns a promise for the state.
 */
function getDeployState() {
    return requestQ("https://jenkins.khanacademy.org/deploy-state.json");
}

/**
 * Returns a promise for the current job ID if one is running, or false if not.
 */
function jenkinsJobStatus(jobName) {
    return request200({
        url: ("https://jenkins.khanacademy.org" +
              `/job/${jobName}/lastBuild/api/json`),
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

/**
 * Get the current running jobs from Jenkins.
 *
 * We check the three jobs deploy-via-multijob, deploy-set-default, and
 * deploy-finish.
 *
 * Returns a promise for an object with two keys, jobName (string) and jobId
 * (number), for the currently running job, or null if there is no job running.
 *
 * If, somehow, multiple such jobs are running, return the first one.  This
 * shouldn't happen.
 */
function getRunningJob() {
    const jobs = ["deploy-via-multijob", "deploy-set-default", "deploy-finish"];
    return Q.all(jobs.map(jenkinsJobStatus))
        .then(jobIds => {
            // `jobIds` is an array of jenkins job IDs corresponding to the names in
            // `jobs` (or null if there is none).  We want to find the first non-null
            // ID, along with the name to which it corresponds.
            const runningIndex = jobIds.findIndex((id, _index) => id);
            return {
                jobName: jobs[runningIndex],
                jobId: jobIds[runningIndex],
            };
        });
}

// postData is an object, which we will encode and post to either
// /job/<job>/build or /job/<job>/buildWithParameters, as appropriate.
// If <job> has a slash in it (because it's in a folder), we expand it
// to the appropriate path.
function runJobOnJenkins(msg, jobName, postData, message) {
    // So deploy/test expands to deploy/job/test
    let jobUrlPart = jobName.split('/').join('/job/');
    let path;
    if (Object.keys(postData).length === 0) {  // no parameters
        path = `/job/${jobUrlPart}/build`;
    } else {
        path = `/job/${jobUrlPart}/buildWithParameters`;
    }

    runOnJenkins(msg, path, postData, message);
}


function cancelJobOnJenkins(msg, jobName, jobId, message) {
    const path = `/job/${jobName}/${jobId}/stop`;
    runOnJenkins(msg, path, {}, message, true);
}


function runOnJenkins(msg, path, postData, message, allowRedirect) {
    // If we haven't yet grabbed a CSRF token (needed for POST requests), then
    // grab one before making our request.
    if (!JENKINS_CSRF_TOKEN) {
        getJenkinsCSRFToken().then(body => {
            postToJenkins(msg, path, postData, message, allowRedirect);
        });
    } else {
        postToJenkins(msg, path, postData, message, allowRedirect);
    }
}


// path should be the URL path; postData should be an object which we will
// encode.  If allowRedirect is falsy, we will consider a 3xx response an
// error.  If allowRedirect is truthy, we will consider a 3xx response a
// success.  (This is because a 302, for instance, might mean that we need to
// follow a redirect to do the thing we want, or it might mean that we were
// successful and are now getting redirected to a new page.)
function postToJenkins(msg, path, postData, message, allowRedirect) {
    postData['Jenkins-Crumb'] = JENKINS_CSRF_TOKEN;

    const options = {
        url: "https://jenkins.khanacademy.org" + path,
        method: "POST",
        form: postData,
        auth: {
            username: "jenkins@khanacademy.org",
            password: process.env.JENKINS_API_TOKEN,
        },
    };
    // Tell readers what we're doing.
    replyAsSun(msg, (DEBUG ? "DEBUG :: " : "") + message);

    if (DEBUG) {
        console.log(options);
        return;
    }

    requestQ(options).then((res, body) => {
        if ((!allowRedirect && res.statusCode > 299) || res.statusCode > 399) {
            logHttpError(res, body);
            throw res;
        }
    }).catch(_err => {
        // Replace the error (which has already been logged) with a more
        // user-friendly one.
        throw new SunError("Jenkins won't listen to me!  You'll have to " +
                           "talk to it yourself.");
    });
}


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


function handleHelp(msg, _deployState) {
    replyAsSun(msg, help_text);
}

function handleEmojiHelp(msg, _deployState) {
    replyAsSun(msg, emoji_help_text);
}

function handlePing(msg, _deployState) {
    replyAsSun(msg, "I AM THE MONKEY KING!");
}

function handleFingersCrossed(msg, _deployState) {
    replyAsSun(msg, "Okay, I've crossed my fingers.  :fingerscrossed:");
}

function handleState(msg, deployState) {
    const prettyState = JSON.stringify(deployState, null, 2);
    return getRunningJob().then(job => {
        const prettyRunningJob = JSON.stringify(job, null, 2);
        replyAsSun(msg, "Here's the state of the deploy: ```" +
            `\n${prettyRunningJob}\n\n${prettyState}\n` + "```");
    });
}

function handlePodBayDoors(msg, _deployState) {
    wrongPipelineStep(msg, "open the pod bay doors");
}

function handleQueueMe(msg, _deployState) {
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
}

function doQueueNext(msg, _deployState) {
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
            let mentions;
            // newDeployer will be either an object with a username key, or a
            // string which we couldn't parse.
            if (newDeployer.usernames) {
                mentions = newDeployer.usernames
                    .map(username => `<@${username}>`)
                    .join(" ");
            } else {
                mentions = newDeployer;
            }
            replyAsSun(msg, `Okay, ${mentions} it is your turn!`);
        }
    });
}

function handleQueueNext(msg, _deployState) {
    // TODO(csilvers): complain if they do 'next' after the happy dance,
    // since we do that automatically now.
    doQueueNext(msg, _deployState);
}


function handleRemoveMe(msg, _deployState) {
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


function handleDeleteZnd(msg, _deployState) {
    const znd_name = msg.match[1].trim();
    const responseText = "Okay, I'll ask Jenkins to delete that ZND!";
    const postData = {
        "ZND_NAME": znd_name,
    };
    runJobOnJenkins(msg, "delete-znd", postData, responseText);
}


function notifyZndOwners(msg, _deployState) {
    const responseText = ("Okay, I'll check in with ZND owners about " +
                          "cleaning up their ZNDs");
    runJobOnJenkins(msg, "notify-znd-owners", {}, responseText);
}


function handleMakeCheck(msg, _deployState) {
    jenkinsJobStatus("make-check").then(runningJob => {
        const deployBranch = msg.match[1];
        const postData = {
            "GIT_REVISION": deployBranch,
            "SLACK_CHANNEL": msg.channel,
            "REPORT_RESULT": true,
        };
        let responseText = ("Telling Jenkins to run tests on branch `" +
                            deployBranch + "`.");
        if (runningJob) {
            responseText += "  They'll run after the current make-check ";
            responseText += "completes.";
        }
        runJobOnJenkins(msg, "deploy/webapp-test", postData, responseText);
    });
}

function handleDeploy(msg, deployState) {
    if (deployState.POSSIBLE_NEXT_STEPS) {
        replyAsSun(msg, "I think there's a deploy already going on.  If that's " +
            "not the case, take it up with Jenkins.");
        return;
    }

    const deployBranch = msg.match[1];
    const caller = msg.user;
    const postData = {
        "GIT_REVISION": deployBranch,
        // In theory this should be an email address but we actually
        // only care about names for the script, so we make up
        // a 'fake' email that yields our name.
        "BUILD_USER_ID_FROM_SCRIPT": caller + "@khanacademy.org"
    };

    runJobOnJenkins(msg, "deploy-via-multijob", postData,
        "Telling Jenkins to deploy branch `" + deployBranch + "`.");
}

function handleSetDefault(msg, deployState) {
    if (!pipelineStepIsValid(deployState, "set-default-start")) {
        wrongPipelineStep(msg, "set-default");
        return;
    }
    const postData = {
        "TOKEN": deployState.TOKEN
    };
    runJobOnJenkins(msg, "deploy-set-default", postData,
        "Telling Jenkins to set `" + deployState.GIT_TAG +
        "` as the default.");
}

function handleAbort(msg, deployState) {
    getRunningJob().then(runningJob => {
        if (runningJob.jobName) {
            // There's a job running, so we should probably cancel it.
            if (runningJob.jobName === "deploy-finish") {
                // We shouldn't cancel a deploy-finish.  If we need to roll
                // back, we now need to do an emergency rollback; otherwise we
                // should just let it finish and then do our thing.
                replyAsSun(msg, "I think there's currently a deploy-finish job " +
                    "running.  If you need to roll back, you will " +
                    "need to do an emergency rollback (:speech_balloon: " +
                    "_“sun: emergency rollback”_).  If not, just let it " +
                    "finish, or <https://jenkins.khanacademy.org/job/" +
                    "deploy-finish/" + runningJob.jobId + "|check what it's" +
                    "doing> yourself.");
            } else {
                // Otherwise, cancel the job.
                cancelJobOnJenkins(msg, runningJob.jobName, runningJob.jobId,
                    "Telling Jenkins to cancel " +
                    runningJob.jobName +
                    " #" + runningJob.jobId + ".");
            }
        } else if (!deployState.POSSIBLE_NEXT_STEPS) {
            // If no deploy is in progress, we had better not abort.
            replyAsSun(msg, "I don't think there's a deploy going.  If you need " +
                "to roll back the production servers because you noticed " +
                "some problems after a deploy finished, :speech_balloon: " +
                "_“sun: emergency rollback”_.  If you think there's a " +
                "deploy going, then I'm confused and you'll have to talk " +
                "to Jenkins yourself.");
        } else {
            // Otherwise, we're between jobs in a deploy, and we should determine
            // from the deploy state what to do.
            const postData = {
                "TOKEN": deployState.TOKEN,
                "WHY": "aborted"
            };
            let response;
            if (pipelineStepIsValid(deployState, "set-default-start")) {
                // If no build is running, and we could set default, we can just as
                // easily just give up
                postData.STATUS = "failure";
                response = "abort";
            } else {
                // Otherwise, we'd better roll back.
                postData.STATUS = "rollback";
                postData.ROLLBACK_TO = deployState.ROLLBACK_TO;
                response = "abort and roll back";
            }
            runJobOnJenkins(msg, "deploy-finish", postData,
                "Telling Jenkins to " + response + " this deploy.");
        }
    });
}

function handleFinish(msg, deployState) {
    if (!pipelineStepIsValid(deployState, "finish-with-success")) {
        wrongPipelineStep(msg, "finish-with-success");
        return;
    }
    let postData = {
        "TOKEN": deployState.TOKEN,
        "STATUS": "success"
    };
    runJobOnJenkins(msg, "deploy-finish", postData,
        "Telling Jenkins to finish this deploy!");

    // wait a little while before notifying the next person.
    // hopefully the happy dance has appeared by then, if not
    // humans will have to figure it out themselves.
    setTimeout(() => doQueueNext(msg, deployState), 20000);
}

function handleEmergencyRollback(msg, _deployState) {
    const jobname = "---EMERGENCY-ROLLBACK---";
    runJobOnJenkins(msg, jobname, {},
        "Telling Jenkins to roll back the live site to a safe " +
        "version");
}

// fn takes a message object and the deploy state.
function handleDeploymentMessage(fn, msg) {
    return getDeployState()
        .spread((res, body) => {
            if (res.statusCode === 404) {
                return {};
            } else if (res.statusCode > 299) {
                logHttpError(res, body);
                throw new SunError("Jenkins won't tell me what's going on.  " +
                                   "You'll have to try it yourself.");
            } else {
                return JSON.parse(body);
            }
        })
        .then(state => fn(msg, state));
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
    [/^test\s+(?:branch\s+)?([^,]*)$/i, handleMakeCheck],
    // Delete a given znd
    [/^delete(?: znd)?\s+(?:znd\s+)?([^,]*)$/i, handleDeleteZnd],
    // Begin the deployment process for the specified branch
    [/^prompt znd cleanup$/i, notifyZndOwners],
    // Begin the deployment process for the specified branch
    [/^deploy\s+(?:branch\s+)?([^,]*)/i, handleDeploy],
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
    [/^:(?:test-tube|100):\s*([^,]*)/i, handleMakeCheck],
    [/^:(?:ship|shipit|passenger_ship|pirate_ship|treeeee):\s*([^,]*)/i,
     handleDeploy],
    [/^:rocket:/i, handleSetDefault],
    [/^:(?:skull|skull_and_crossbones|sad_mac|sadpanda|party_parrot_sad):/i,
     handleAbort],
    [/^:(?:cry|disappointed):/i, handleAbort],
    [/^:(?:yolo|party_dino|ballot_box_with_check|checkered_flag):/i,
     handleFinish],
    [/^:(?:heavy_check_mark|white_check_mark):/i, handleFinish],
    [/^:scream:/i, handleEmergencyRollback],
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
            handleDeploymentMessage(fn, message)
            .catch(err => onError(message, err))
            .then(() => res.send({}));
            return;
        }
    }
});

const server = app.listen(process.env.PORT || "8080", "0.0.0.0", () => {
    console.log("App listening at https://%s:%s",
        server.address().address, server.address().port);
    console.log("Press Ctrl-C to quit.");
});
