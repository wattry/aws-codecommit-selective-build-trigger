const AWS = require('aws-sdk');

const codecommit = new AWS.CodeCommit();
const codebuild = new AWS.CodeBuild();
const ecr = new AWS.ECR();

const {
  basename,
  sep
} = require('path');

const FILENAMES = ["DockerFile", "Dockerfile"];
const {
  CODE_BUILD_PROJECT
} = process.env;

async function getLastCommitID(repositoryName, branchName) {
  if (!branchName) throw new Error('Branch name not provided');
  const {
    branch: {
      commitId
    }
  } = await codecommit
    .getBranch({
      repositoryName,
      branchName
    })
    .promise();

  return commitId;
}

async function getLastCommitLog(repositoryName, commitId) {
  const {
    commit
  } = await codecommit
    .getCommit({
      repositoryName,
      commitId
    })
    .promise();

  return commit;
}

async function getFileDifferences(repositoryName, lastCommitID, previousCommitID) {
  const options = {
    repositoryName,
    afterCommitSpecifier: lastCommitID
  };

  if (previousCommitID) options.beforeCommitSpecifier = previousCommitID;

  const {
    differences = []
  } = await codecommit
    .getDifferences(options)
    .promise();

  return differences;
}

async function checkEcrRepository(repositoryName) {
  try {
    const { repositories: [repository] } = await ecr
      .describeRepositories({ repositoryNames: [repositoryName] })
      .promise();

    return repository;
  } catch (error) {
    // If the ecr repository does not exist, then create one with the name provided.
    if (error.name && error.name === 'RepositoryNotFoundException') {
      try {
        const { repository } = await ecr
          .createRepository({ repositoryName })
          .promise();

        return repository;
      } catch (error) {
        console.log('Unable to create repository: %s', repositoryName, error);
      }
    }

    console.log('Unable to check repository: %s', repositoryName, error);
  }
}

/**
 * Initiates codebuild pipeline in the queue.
 * @param {Array[{ NAME: String, VALUE: any, TYPE: string }]} environmentVariablesOverride
 * @returns {Promise} - logs out when build is queued.
 */
async function buildImage(environmentVariablesOverride) {
  try {
    const buildOptions = {
      projectName: CODE_BUILD_PROJECT,
      sourceVersion: commitHash,
      sourceTypeOverride: 'CODECOMMIT',
      sourceLocationOverride: `https://git-codecommit.${awsRegion}.amazonaws.com/v1/repos/${gitRepoName}`,
      environmentVariablesOverride
    };

    await codebuild.startBuild(buildOptions).promise();

    console.log('Queued pipeline build');
  } catch (error) {
    console.error('Unable to queue pipeline build:', error);
  }
}

exports.handler = async (event) => {
  try {
    console.log('event', event);
    const {
      Records: [{
        awsRegion,
        codecommit: {
          references: [{
            commit,
            commitHash = commit || getLastCommitID(gitRepoName, branchName),
            ref,
            deleted,
            branchName = basename(ref)
          }]
        },
        eventSourceARN,
        gitRepoName = eventSourceARN.split(':').pop(),
        accountId = eventSourceARN.split(':')[4]
      }]
    } = event;

    const { parents: [previousCommitID] } = await getLastCommitLog(gitRepoName, commitHash);
    const differences = await getFileDifferences(gitRepoName, commitHash, previousCommitID);
    const imageActions = [];

    for (let i = 0; i < differences.length; i++) {
      const {
        afterBlob: {
          path,
          directory = path.split(sep).shift(),
          fileName = basename(path)
        }
      } = differences[i];

      if (FILENAMES.includes(fileName)) {
        imageActions.push(
          checkEcrRepository(`customer-portal-${directory}-${branchName}`)
            .then(({ repositoryName: ecrRepositoryName, repositoryUri: ecrRepositoryUri, repositoryArn: ecrRepositoryArn }) => {
              return deleted
                ? ecr.deleteRepository({ repositoryArn: ecrRepositoryArn }).promise()
                : buildImage(ecrRepositoryName, [
                  {
                    name: 'AWS_DEFAULT_REGION',
                    value: awsRegion,
                    type: 'PLAINTEXT'
                  },
                  {
                    name: 'ECR_REPO',
                    value: ecrRepositoryName,
                    type: 'PLAINTEXT'
                  }, {
                    name: 'ECR_REPO_URI',
                    value: ecrRepositoryUri,
                    type: 'PLAINTEXT'
                  }, {
                    name: 'AWS_ACCOUNT_ID',
                    value: accountId,
                    type: 'PLAINTEXT'
                  },
                  {
                    name: 'APP_DIR',
                    value: directory,
                    type: 'PLAINTEXT'
                  },
                  {
                    name: 'BRANCH_NAME',
                    value: branchName,
                    type: 'PLAINTEXT'
                  }
                ]);
            })
        );
      }
    }

    return Promise.allSettled(imageActions);
  } catch (error) {
    console.error('An error occurred building images', error);
  }
};