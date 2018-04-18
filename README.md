# Slack Deploy Hooks
> The Khan deployment service for Slack

Slack Deploy Hooks replace the old Sun Wukong Hubot plugin and adds a
lot of functionality.

**This repository is no longer used, and retained only for posterity.  See
Khan/buildmaster for the new version.**

## Settings

The environment variable `DEPLOY_ROOM_ID` sets the room in which the hooks will
listen.  It should be a Slack channel ID, which you can get from the [Slack API
test client][api-test].

[api-test]: https://api.slack.com/methods/channels.list/test

For a deploy, you will also need several secrets.  The deploy script will give
instructions.

## Making a deploy

### Prerequisites
You will need to install Node and npm through the usual channels (0.12.7
or higher, please), and will also need a working `gcloud` tool for deploying.

Node can be install via the usual `brew install node`.

Set up the gcloud tool as [per instructions][gcloud-install]. (Note
that on Mac you can use `brew cask install google-cloud-sdk` instead of their
installer, if you prefer.)

[gcloud-install]: https://cloud.google.com/container-engine/docs/before-you-begin#install_the_gcloud_command_line_interface

### Development

First, you can optionally provision secrets locally. Instructions will be
given on your first deploy.

The Slack deploy hooks are a vanilla Node application, so a simple

    $ npm install
    $ env SUN_DEBUG=1 SLACK_BOT_TOKEN=`cat .slack_bot_token` npm run monitor

Will give you a fully set-up local copy of khan-sun. You can then easily test
it simply by using a tool like httpie and submitting Slack outgoing webhooks
and observing the result. For example, to test the sun: ping command:

    curl -d 'team_id=T0001&team_domain=example&channel_id=C090KRE5P&channel_name=bot-testing&user_id=U09M5G8G6&user_name=csilvers&text=sun: ping&trigger_word=sun:' localhost:8080

Should give you the response like `{}`, indicating success, from the HTTP
command, and print out the response text in the terminal running Sun. (If you
do not see any output, you probably forgot to set the `SUN_DEBUG` flag specified
above.)

### Build and Deploy

All you have to do is run `npm run deploy` and follow directions.

You will need some secrets installed. The deploy script will complain if it
can't find them, letting you know the details of which secrets are expected in
which files.

You also need to have loggged in with `gcloud` and must have permissions in the
`khan-sun` project.
