

function asynchronous(throwError , i, functionName) {
  return new Promise((resolve, reject) => {

    console.log('functionName', functionName);
    if (throwError) {
      setTimeout(() => {
        return reject({ success: false, message: 'We fucken failed!', i, functionName });
      }, 2000)  
    } else {
      setTimeout(() => {
        return resolve({ success: true, message: 'Yay we fucken did it!', i, functionName });
      }, 1000)
    }
  });
}

async function asyncFunc(reject = false, i = 1 ) {
  try {
    const result = await asynchronous(reject, i, 'asyncFunc');

    console.log('result', result);

    return result;
  } catch (error) {
    console.log('error', error)
  }
}

asyncFuncLoop()

function syncFunc(reject = false, i = 1) {
  
  return asynchronous(reject, 1, 'syncFunc')
    .then(result => {
      console.log('result', result);
    })
    .catch(error => {
      console.log('error', error)
    });
}

async function asyncFuncLoop() {
  for (let i = 0; i < 5; i++) {
    if (i === 3) {
      asyncFunc(true, i)
    } else {
      asyncFunc(false, i)
    }
  }
}

function syncFuncLoop() {

  for (let i = 0; i < 5; i++) {
    if (i === 3) {
      asynchronous(true);
    } else {
      asynchronous();
    }
  }
}

async function handler() {


}

