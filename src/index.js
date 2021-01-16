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
  CODE_BUILD_PROJECT = 'wattry-ecr-poc-CodeBuild-Job'
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

function getServicesDirectories(repositoryName, folderPath, commitSpecifier) {
  return codecommit.getFolder({ repositoryName, folderPath, commitSpecifier }).promise()
}

async function createEcrRepository(repositoryName) {
  const { repository } = await ecr
    .createRepository({ repositoryName })
    .promise();

  console.log('Creating repository: %s', repositoryName);

  return repository;
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
        const { repository } = createEcrRepository(repositoryName);

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
async function buildImage(
  commitHash,
  awsRegion,
  gitRepoName,
  { repositoryName, repositoryUri },
  imageDirectory,
  accountId,
  branchName,
  environmentVariablesOverride = []
) {
  try {
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
          value: imageDirectory,
          type: 'PLAINTEXT'
        },
        {
          name: 'BRANCH_NAME',
          value: branchName,
          type: 'PLAINTEXT'
        },
        ...environmentVariablesOverride
      ]
    };

    const result = await codebuild.startBuild(buildOptions).promise();

    console.log('Queued pipeline build');

    return result;
  } catch (error) {
    console.error('Unable to queue pipeline build:', error);
  }
}

async function deleteEcrRepository(branchName) {
  try {
    const { repositories } = await ecr.describeRepositories().promise();
    const regex = new RegExp(`^customer-portal.*.${branchName}$`);
    const repositoriesToDelete = repositories.map(({ repositoryName }) => {
      if (!/master|main|dev|prod/.test(branchName) && regex.test(repositoryName)) {
        return ecr.deleteRepository({ repositoryName, force: true }).promise()
          .then(() => {
            console.log('Repository "%s" scheduled for deletion', repositoryName);
            return { status: 'deleted', repositoryName };
          })
      }

      return { status: 'skipped', repositoryName };
    });

    return Promise.allSettled(repositoriesToDelete);
  } catch (error) {
    console.log('An error occurred deleting %s repository', branchName, error);
  }
}

async function createServiceRepositories(gitRepoName, commitHash, servicesPath, branchName, build) {
  const { subFolders: serviceNames } = await getServicesDirectories(gitRepoName, servicesPath, commitHash);

  return serviceNames
    .map(({
      relativePath: serviceName,
      absolutePath: serviceDirectory
    }) => createEcrRepository(`customer-portal-${(serviceName)}-${branchName}`)
      .then(repository => build(repository, serviceName, serviceDirectory))
      .catch(error => console.error('Unable to create service repository.', error.message))
    );
}

async function updateErcImages(gitRepoName, commitHash, branchName, build) {
  const { parents: [previousCommitID] } = await getLastCommitLog(gitRepoName, commitHash);
  const differences = await getFileDifferences(gitRepoName, commitHash, previousCommitID);
  const hasQueuedBuild = [];

  const builds = differences.map(difference => {
    const {
      afterBlob: {
        path
      },
      serviceDirectory,
      serviceName = path.split(sep),
      file = basename(path).split('.')
    } = difference;
    const [fileName, extension] = file;

    return

    if ((EXTENSIONS.includes(extension) || FILENAMES.includes(fileName)) && !hasQueuedBuild.includes(imageDirectory)) {
      hasQueuedBuild.push(imageDirectory);

      return checkEcrRepository(`customer-portal-${imageDirectory}-${branchName}`)
        .then(repository => build(repository, imageDirectory));
    }

    console.log('Skipped %s', file);
  });

  return Promise.allSettled(builds);
}

const handler = async (event) => {
  try {
    // console.log('event', JSON.stringify(event));
    const {
      Records: [{
        awsRegion,
        codecommit: {
          references: [{
            commit,
            ref,
            deleted,
            created
          }]
        },
        eventSourceARN,
      }],
      gitRepoName = eventSourceARN.split(':').pop(),
      accountId = eventSourceARN.split(':')[4],
      branchName = basename(ref),
      commitHash = commit || getLastCommitID(gitRepoName, branchName),
    } = event;

    if (deleted) {
      return deleteEcrRepository(branchName);
    } else if (created) {
      return createServiceRepositories(gitRepoName, commitHash, 'backend/services', branchName, (repository, serviceName, serviceDirectory) =>
        buildImage(commitHash, awsRegion, gitRepoName, repository, serviceDirectory, accountId, branchName)
      );
    } else {
      return updateErcImages(gitRepoName, commitHash, branchName, repository =>
        buildImage(commitHash, awsRegion, gitRepoName, repository, `backend/services/${serviceName}`, accountId, branchName)
      );
    }

  } catch (error) {
    console.error('An error occurred building images', error);
  }
};

exports.handler = handler;