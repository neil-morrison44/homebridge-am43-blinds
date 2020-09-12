// @ts-check

const noble = require("@abandonware/noble")
const { CONFIG_KEY_ALLOWED_DEVICES } = require("../variables/platform")
const { AM43_SERVICE_ID } = require("../variables/platform")
const { sleep } = require("../utils")

const discoverBlinds = (allowedDevices, log, scanningTimeout) => {
  return new Promise((resolve, reject) => {
    const foundBlinds = []
    noble.on("discover", (peripheral) => {
      log(`found`, peripheral)
      const deviceIdentifier =
        peripheral.address != null ? peripheral.address : peripheral.id
      if (allowedDevices && !allowedDevices.includes(deviceIdentifier)) {
        log.warn(
          `Device ${deviceIdentifier} is not found on the '${CONFIG_KEY_ALLOWED_DEVICES}' array in config.json and is ignored.`
        )
        log.warn(
          `Add it to config.json to be able to use the device, you can use this identifier: '${deviceIdentifier}'. Example: ' "allowed_devices": ["${deviceIdentifier}"] '`
        )
        log.warn(
          `Or set '${CONFIG_KEY_ALLOWED_DEVICES}' to 'null' to allow all devices. Setting 'null' is not recommended!`
        )
        return
      } else {
        foundBlinds.push(peripheral)
      }
    })

    noble.on("scanStop", async () => {
      await sleep(500)
      resolve(foundBlinds)
    })
    log("starting scan for devices")
    noble.startScanning([AM43_SERVICE_ID], false, (error) => {
      if (error) reject(error)
    })

    setTimeout(() => {
      noble.stopScanning((error) => {
        if (error) this.log.error("Failed to stop searching for AM43 blinds")
      })
    }, scanningTimeout * 1000)
  })
}

module.exports = { discoverBlinds }
