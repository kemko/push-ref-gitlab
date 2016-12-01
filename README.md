# About

This Node.js script will accept a git ref as an argument and push it to a Gitlab repository. It's a test to see if Gitlab CI features can be used for repositories hosted on GitHub.

## Installation

Clone this repository and use npm to install:

``npm install -g``

## Usage

```
/usr/bin/push-ref-gitlab \
--build-events-webhook-url=http://host:port/path \
--gitlab-instance=https://gitlab.com \
--github-repo-owner=github-account-name \
--github-repo-name=github-repo-to-mirror \
--gitlab-repo-owner=gitlab-account-name \
--gitlab-repo-name=gitlab-target-repo \
--ref=git-ref-to-push \
--gitlab-token=gitlab-ci-runner-token \
--gitlab-runner-id=gitlab-ci-runner-id \
--cwd=working-directory
```