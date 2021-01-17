const AWS = require('aws-sdk');
const path = require('path');

const codecommit = new AWS.CodeCommit();
const codebuild = new AWS.CodeBuild();
const ecr = new AWS.ECR();

const EXTENSIONS = [".js"];
const FILENAMES = ["DockerFile", "Dockerfile"];
const {
  CODE_BUILD_PROJECT = 'wattry-ecr-poc-CodeBuild-Job',
  SERVICES_PATH = 'backend/services',
  SERVICE_PREFIX = 'customer-portal'
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

function getServicesDirectories(repositoryName, commitSpecifier) {
  return codecommit.getFolder({ repositoryName, folderPath: SERVICES_PATH, commitSpecifier }).promise()
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
        const repository = await createEcrRepository(repositoryName);

        console.log('Repository %s created', repository.repositoryName);
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
  awsRegion,
  accountId,
  commitHash,
  gitRepoName,
  branchName,
  ecrRepository,
  serviceName,
  serviceDirectory,
  environmentVariablesOverride = []
) {
  const { repositoryName, repositoryUri } = ecrRepository;
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
        name: 'SERVICE_DIR',
        value: serviceDirectory,
        type: 'PLAINTEXT'
      },
      {
        name: 'SERVICE_NAME',
        value: serviceName,
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

  return codebuild.startBuild(buildOptions).promise()
    .then(() => {
      console.log('Building Repository %s', repositoryName);
    })
}

async function deleteEcrRepository(branchName, serviceName) {
  try {
    const { repositories } = await ecr.describeRepositories().promise();
    const regex = serviceName
      ? new RegExp(`^${SERVICE_PREFIX}.${serviceName}.${branchName}$`)
      : new RegExp(`^${SERVICE_PREFIX}.*.${branchName}$`);

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

async function createServiceRepositories(gitRepoName, commitHash, branchName, build) {
  const { subFolders: serviceNames } = await getServicesDirectories(gitRepoName, commitHash);

  return serviceNames
    .map(({
      relativePath: serviceName,
      absolutePath: serviceDirectory
    }) => createEcrRepository(`${SERVICE_PREFIX}-${(serviceName)}-${branchName}`)
      .then(repository => {
        console.log('Repository created: %s', repository);

        build(repository, serviceName, serviceDirectory)
      })
      .catch(error => console.error('Unable to create service repository.', error.message))
    );
}

async function updateErcImages(gitRepoName, commitHash, branchName, build) {
  const { parents: [previousCommitID] } = await getLastCommitLog(gitRepoName, commitHash);
  const differences = await getFileDifferences(gitRepoName, commitHash, previousCommitID);
  const hasQueuedBuild = [];

  console.log(differences);

  const builds = differences.map((difference) => {
    const {
      beforeBlob: {
        path: servicePath,
      },
      changeType,
      deleted = changeType === 'D' ? true : false
    } = difference;
    const {
      dir,
      pathArray = dir.split(path.sep),
      serviceName = pathArray[2],
      serviceDirectory = pathArray.splice(0, 3).join(path.sep),
      name: fileName,
      ext: extension
    } = path.parse(servicePath);

    if (FILENAMES.includes(fileName) && deleted && !hasQueuedBuild.includes(serviceName)) {
      hasQueuedBuild.push(serviceName);

      return deleteEcrRepository(branchName, serviceName);

    } else if ((EXTENSIONS.includes(extension) || FILENAMES.includes(fileName)) && !hasQueuedBuild.includes(serviceName)) {
      hasQueuedBuild.push(serviceName);

      return checkEcrRepository(`${SERVICE_PREFIX}-${serviceName}-${branchName}`)
        .then(repository => build(repository, serviceName, serviceDirectory));
    }

    console.log('Skipped %s', serviceName);
    return { serviceName, fileName, status: 'skipped' };
  });

  return Promise.allSettled(builds);
}

const handler = async (event) => {
  try {
    console.log('event', JSON.stringify(event));
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
      branchName = path.basename(ref),
      commitHash = commit || getLastCommitID(gitRepoName, branchName),
    } = event;

    if (deleted) {
      return deleteEcrRepository(branchName);
    } else if (created) {
      return createServiceRepositories(gitRepoName, commitHash, branchName, (ecrRepository, serviceName, serviceDirectory) =>
        buildImage(awsRegion, accountId, commitHash, gitRepoName, branchName, ecrRepository, serviceName, serviceDirectory)
      );
    } else {
      return updateErcImages(gitRepoName, commitHash, branchName, (ecrRepository, serviceName, serviceDirectory) =>
        buildImage(awsRegion, accountId, commitHash, gitRepoName, branchName, ecrRepository, serviceName, serviceDirectory)
      );
    }

  } catch (error) {
    console.error('An error occurred building images', error);
  }
};

exports.handler = handler;