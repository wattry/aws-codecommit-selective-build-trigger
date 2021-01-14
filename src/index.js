const AWS = require('aws-sdk');

const codecommit = new AWS.CodeCommit();
const codebuild = new AWS.CodeBuild();
const ecr = new AWS.ECR();

const {
  basename,
  sep
} = require('path');

const EXTENSIONS = ["js"];
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
    const imagesToBuild = [];
    const isImageBuilt = [];

    for (let i = 0; i < differences.length; i++) {
      console.log('diff', JSON.stringify(differences[i]));
      const {
        afterBlob: {
          path,
          directory = path.split(sep).shift(),
          file = basename(path).split('.')
        }
      } = differences[i];
      const [fileName, extension] = file;

      if ((EXTENSIONS.includes(extension) || FILENAMES.includes(fileName)) && !isImageBuilt.includes(directory)) {
        isImageBuilt.push(directory);
        imagesToBuild.push(
          checkEcrRepository(`customer-portal-${directory}-${branchName}`)
            .then(({ repositoryName, repositoryUri, repositoryArn }) => {
              console.log('repositoryName', repositoryName, 'repositoryUri', repositoryUri, 'repositoryArn', repositoryArn);

              const buildOptions = {
                projectName: CODE_BUILD_PROJECT,
                sourceVersion: commitHash,
                sourceTypeOverride: 'CODECOMMIT',
                sourceLocationOverride: `https://git-codecommit.${awsRegion}.amazonaws.com/v1/repos/${gitRepoName}`,
                environmentVariablesOverride: [
                  {
                    name: 'AWS_DEFAULT_REGION',
                    value: awsRegion,
                    type: 'PLAINTEXT'
                  },
                  {
                    name: 'ECR_REPO',
                    value: repositoryName,
                    type: 'PLAINTEXT'
                  }, {
                    name: 'ECR_REPO_URI',
                    value: repositoryUri,
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
                ]
              };

              return codebuild.startBuild(buildOptions).promise().then(() => {
                console.log('Image build queued: %s', directory);
              });
            })
        );
      } else if (isImageBuilt.includes(directory)) {
        console.log('Skipping build. %s is already queued', directory);
      }
    }

    return Promise.allSettled(imagesToBuild);
  } catch (error) {
    console.error('An error occurred building images', error);
  }
};