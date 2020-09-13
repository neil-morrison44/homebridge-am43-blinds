const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const timeoutPromise = (ms, errorText) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(errorText)), ms))

module.exports = { sleep, timeoutPromise }
