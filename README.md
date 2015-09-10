# Khan Sun
> The Khan deployment service for Slack

Khan Sun replaces the old Sun Wukong Hubot plugin with a much simpler
webhook-based solution that otherwise works identically.

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

Khan Sun is a vanilla Node application, so a simple

    $ npm install
    $ npm run monitor

Will give you a fully

WRITE THIS

    $ docker-compose run --rm hubot
    slacker-cow> [Mon Aug 31 2015 15:47:34 GMT+0000 (UTC)] INFO /hubot/scripts/sun.js is using deprecated documentation syntax
    [Mon Aug 31 2015 15:47:34 GMT+0000 (UTC)] INFO hubot-redis-brain: Discovered redis from REDIS_URL environment variable

    slacker-cow> slacker-cow: ping
    slacker-cow> PONG

    slacker-cow> sun, finish up
    slacker-cow> Shell: I'm not going to finish -- it's not time for that. If you disagree, bring it up with Jenkins.

The docker compose configuration automatically mounts the `/hubot/bin` and
`/hubot/scripts` directories in the container as volumes, so that you can test
code modifications without rebuilding the image.


### Build and Deploy

All you have to do is run `npm run deploy` and follow directions. That's it.
