#!/usr/bin/env node

"use strict";

var https = require('https'),
  qs = require('querystring'),
  url = require('url'),
  fs = require("fs"),
  spawn = require("child_process").spawn,
  argv = require('minimist')(process.argv.slice(2), {
    boolean: ["gitlab-enable-shared-runners"],
    default: {
      "gitlab-enable-shared-runners": true,
      "gitlab-instance": "https://gitlab.com",
      cwd: process.cwd()
    }
  });

var BENIGN_ERRORS = [
  "Runner was already enabled for this project",
  "404 Project Not Found"
];

var BUILD_EVENTS_WEBHOOK_URL = argv['build-events-webhook-url'];

var GITLAB_HOST = argv['gitlab-instance'];
var GITLAB_USER = argv['gitlab-repo-owner'];
var GITLAB_TOKEN = argv['gitlab-token'];
var GITLAB_ENABLE_SHARED_RUNNERS = argv['gitlab-enable-shared-runners'];

var GITHUB_REF = argv['ref'].split("/").slice(-1)[0];
var GITHUB_USER = argv['github-auth-user'];
var GITHUB_REPO_OWNER = argv['github-repo-owner']
var GITHUB_REPO_PATH = argv['github-repo-path'];
var repoName = GITHUB_REPO_PATH.split("/").slice(-1)[0];
var GITHUB_TOKEN = argv['github-private-token'];


var CWD = argv['cwd'];

var GITLAB_USER_AND_REPO = GITLAB_USER + "%2F" + repoName;


function pathExists(path) {
  try {
    fs.statSync(path);
    return true;
  } catch (err) {
    return false;
  }
}

function makeGitlabRequest(path, data) {
  var headers = {
    "PRIVATE-TOKEN": GITLAB_TOKEN
  };

  if (data) {
    data = qs.stringify(data);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(data);
  }

  var parsed = url.parse(GITLAB_HOST);
  return new Promise(function(resolve, reject) {
    var request = https.request({
      host: parsed.host,
      port: parsed.port || '443',
      path: "/api/v3/" + path,
      method: data ? 'POST' : 'GET',
      headers: headers
    }, function(res) {
      res.setEncoding("utf8");
      var body = "";
      res.on("data", function(data) {
        body += data;
      }).on("error", function(e) {
        e.res = res;
        reject(e);
      }).on("end", function() {
        try {
          body = JSON.parse(body)
        } catch (e) {}

        // Let's start panicking here if we get client or server errors, or if the message
        // returned by Gitlab is something other than what we expect.
        if (res.statusCode >= 400 && BENIGN_ERRORS.indexOf(body.message) === -1) {
          reject(body);
        } else {
          body.res = res;
          resolve(body);
        }
      });
    }).on("error", function(e) {
      reject(e);
    });

    // Handle post data
    if (data) {
      request.write(data, "utf8");
    }

    request.end();
  });
}

function doesGitlabProjectExist(repo, account) {
  return makeGitlabRequest("projects/" + account + "%2F" + repo).then(function(data) {
    data = data || {};
    data.projectExists = data.res.statusCode !== 404;
    return data;
  });
}

function doesGitlabBuildEventsHookExists(repo, account, webhookUrl) {
  return makeGitlabRequest("projects/" + account + "%2F" + repo + '/hooks').then(function(data) {
    data = data || {};
    var hook = {};
    data.forEach(function(item) {
      if (item.url == webhookUrl) hook = item;
    });
    return hook.hasOwnProperty('url') ? hook : false;
  });
}

// Shared runners are being disabled because the ones provided by gitlab.com will not provide
// IDI supported environments
function createGitlabProject(repo, account) {
  return makeGitlabRequest('/projects', {
    name: repo,
    shared_runners_enabled: GITLAB_ENABLE_SHARED_RUNNERS,
    issues_enabled: "false"
  });
}

function ensureGitlabProjectExists(repo, account) {
  console.log("Checking if " + repoName + " project exists...");
  return doesGitlabProjectExist(repoName, GITLAB_USER).then(function(data) {
    console.log(GITLAB_USER + "/" + repoName + " project " + (data.projectExists ? "exists" : "doesn't exist."));
    if (data.projectExists) {
      return data;
    }

    console.log("Creating the project.");
    return createGitlabProject(repo, account);
  });
}

function enableGitlabRunner(projectId) {
  return makeGitlabRequest('/projects/' + projectId + '/runners', {
    runner_id: GITLAB_RUNNER_ID
  });
}

function ensureGitlabBuildEventsHookExists(projectFullName, webhookUrl) {
  console.log("Checking if " + repoName + " hook exists...");
  return doesGitlabBuildEventsHookExists(repoName, GITLAB_USER, webhookUrl).then(function(data) {
    console.log(GITLAB_USER + "/" + repoName + " hook " + (data.url ? "exists" : "doesn't exist."));
    if (data.url) {
      return data;
    }

    console.log("Creating the hook.");
    return addGitlabBuildEventsHook(projectFullName, webhookUrl);
  });
}

function addGitlabBuildEventsHook(projectFullName, webhookUrl) {
  return makeGitlabRequest('projects/' + projectFullName + '/hooks', {
    url: webhookUrl,
    build_events: "true",
    push_events: "false"
  });
}

function git(command, args, opts) {
  opts = opts || {};
  opts.stdio = ["pipe", "pipe", "inherit"];
  return new Promise(function(resolve, reject) {
    var proc = spawn("git", [command].concat(args), opts);
    var output = "";
    proc.stdout.on("data", function(chunk) {
      output += chunk;
    });

    proc.on("error", reject).on("close", function(exitCode) {
      if (exitCode !== 0) {
        console.warn("The git command returned non-zero exit code!");
      }
      resolve(output.trim());
    });
  });
}

function cloneRepo(outputDir) {
  return git("clone", ["https://" + GITHUB_USER + ":" + GITHUB_TOKEN + "@github.com/" + GITHUB_REPO_PATH, outputDir]);
}

function addRemote(repoName) {
  var dir = getRepoWorkingDirPath(repoName);
  var parsed = url.parse(GITLAB_HOST);
  return git("remote", [
    "add",
    "gitlab",
    "https://" + GITLAB_USER + ":" + GITLAB_TOKEN + "@" + parsed.hostname + "/" + GITLAB_USER + "/" + repoName + ".git"
  ], {
    cwd: dir
  });
}

function getGitlabRemote(repoName) {
  var dir = getRepoWorkingDirPath(repoName);
  return new Promise(function(res, rej) {
    // If there's no remote and that causes a failure here, let's resolve with an empty string
    git("remote", [
      "remove",
      "gitlab"
    ], {
      cwd: dir
    }).then(function(url) {
      res(url);
    }).catch(function(e) {
      res("");
    });
  });
}

// Takes git ref arg and pushes to Gitlab remote of repo arg
function pushRef(repoName, ref) {
  var dir = getRepoWorkingDirPath(repoName);
  return git("push", [
    "gitlab",
    "origin/" + GITHUB_REF + ":refs/heads/" + GITHUB_REF,
    "--force"
  ], {
    cwd: dir
  });
}

function getRepoWorkingDirPath(repoName) {
  return CWD + "/" + GITHUB_REPO_OWNER + "_" + repoName;
}

function ensureRepoWorkingDirExistsAndUpdated(repoName) {
  var dir = getRepoWorkingDirPath(repoName);
  if (pathExists(dir)) {

    return git("fetch", [
      "origin"
    ], {
      cwd: dir
    });
  } else {
    return cloneRepo(dir);
  }
}

function ensureRepoRemoteExists(repoName) {
  return getGitlabRemote(repoName).then(function(url) {
    return addRemote(repoName);
  });
}

console.log("Ensuring the project exists...");
ensureGitlabProjectExists(repoName, GITLAB_USER).then(function(data) {
  /*    // Add the CI runner's ID
      console.log("Enabling the CI runner...");
      return enableGitlabRunner(data.id)
  }).then(function (data) { */
  console.log("Adding build events hook URL...");
  return ensureGitlabBuildEventsHookExists(GITLAB_USER_AND_REPO, BUILD_EVENTS_WEBHOOK_URL);
}).then(function(data) {
  console.log("Cloning the repository: " + GITHUB_REPO_PATH);
  return ensureRepoWorkingDirExists(repoName);
}).then(function(data) {
  console.log("The repository exists on the disk.");
  console.log("Making sure the Gitlab remote exists...");
  return ensureRepoRemoteExists(repoName);
}).then(function(data) {
  console.log("Added the Gitlab remote.");
  console.log("Pushing the ref...");
  return pushRef(repoName, GITHUB_REF);
}).then(function() {
  console.log("Pushed the ref to Gitlab.");
}).catch(function(e) {
  console.error(e.stack || e);
});
