// @ts-check

const AM43DeviceModule = require("./AM43Device")
const AM43Device = AM43DeviceModule.AM43Device
const packageJSON = require("../package.json")
const noble = require("@abandonware/noble")
const {
  CONFIG_KEY_ALLOWED_DEVICES,
  CONFIG_KEY_HAP_INTERACTION_TIMEOUT,
  CONFIG_KEY_POLL_INTERVAL,
  MINIMUM_POLL_INTERVAL,
  DEFAULT_HAP_INTERACTION_TIMEOUT,
  HAP_NO_INTERACTION_GRACE_PERIOD,
  MISSING_DEVICES_SCANNING_TIMEOUT,
  POSITION_UPDATE_INTERVAL,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_SCANNING_TIMEOUT,
} = require("./variables/platform")
const { discoverBlinds } = require("./ble/discover")
const { sleep } = require("./utils")
const poll = require("poll").default

class AM43Platform {
  constructor(log, config, api) {
    this.configJSON = config
    this.log = log
    this.api = api

    this.packageJSON = packageJSON
    this.accessories = []

    this.log.info("Starting AM43 platform")

    this.isScanning = false

    this.discoveredDevices = []

    let configuredAllowedDevicesList = this.configJSON[
      CONFIG_KEY_ALLOWED_DEVICES
    ]
    if (configuredAllowedDevicesList !== undefined) {
      if (configuredAllowedDevicesList == null) {
        this.allowedDevices = null
      } else if (Array.isArray(configuredAllowedDevicesList)) {
        this.allowedDevices = configuredAllowedDevicesList
      } else {
        this.log.error(
          `The config.json defines '${CONFIG_KEY_ALLOWED_DEVICES}' list but it seems to be an invalid format. The list should be an array, example: ['MAC1', 'MAC2']`
        )
        this.allowedDevices = []
      }
    } else {
      this.log["info"](
        `No ${CONFIG_KEY_ALLOWED_DEVICES} field found. Ignoring all devices`
      )
      this.allowedDevices = []
    }

    if (
      this.configJSON[CONFIG_KEY_HAP_INTERACTION_TIMEOUT] != undefined &&
      this.configJSON[CONFIG_KEY_HAP_INTERACTION_TIMEOUT] <= 0
    ) {
      this.log.warn(
        "Automatic disconnection of AM43 devices is disabled and the connection will be kept open. This might cause higher power usage of the devices but improve responsiveness."
      )
    }

    if (
      this.configJSON[CONFIG_KEY_POLL_INTERVAL] != undefined &&
      this.configJSON[CONFIG_KEY_POLL_INTERVAL] < MINIMUM_POLL_INTERVAL
    ) {
      this.log.warn(
        `Polling for devices is disabled due too a low poll interval. This might cause an incorrect state in HomeKit apps. Polling requires a value of ${MINIMUM_POLL_INTERVAL} (seconds) or higher.`
      )
    }

    api.on("didFinishLaunching", () => this.scanForDevices())

    api.on("shutdown", () => {
      this.shutdown()
    })
  }

  async scanForDevices() {
    // Start scanning with noble!
    if (this.isScanning) return
    this.isScanning = true
    const blinds = await discoverBlinds(
      this.allowedDevices,
      this.log,
      DEFAULT_SCANNING_TIMEOUT
    )
    this.isScanning = false
    const devices = blinds.map(
      (rawBLEPeripheral) => new AM43Device(rawBLEPeripheral, this.log)
    )

    devices.forEach((device) => {
      const uuid = this.api.hap.uuid.generate(device.id)
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID == uuid
      )
      if (!existingAccessory) {
        this.log.info("Found new AM43 Motor: " + device.description)
        let accessory = this.createAccessory(device, uuid)
        this.configureDeviceOnAccessory(accessory, device)
        this.api.registerPlatformAccessories(
          "homebridge-am43-blinds",
          "am43-blinds",
          [accessory]
        )
      } else {
        this.log.info("Found known AM43 Motor: " + device.description)
        this.configureDeviceOnAccessory(existingAccessory, device)
        this.api.updatePlatformAccessories([existingAccessory])
      }
    })

    for (let index = 0; index < devices.length; index++) {
      const device = devices[index]
      device.prepareAsync()
      await sleep(500)
    }
  }

  shutdown() {
    this.log.info(
      "Homebridge is shutting down, disconnecting AM43 motors and saving state"
    )
    this.accessories.forEach((accessory) => {
      if (!accessory.am43device) return

      accessory.context.am43.lastPosition = accessory.am43device.position
      accessory.context.am43.lastBatteryPercentage =
        accessory.am43device.batteryPercentage
      accessory.am43device.disconnectAsync()
    })
  }

  startScanningForDevices(timeout) {
    // if (this.isScanning) return
    // this.isScanning = true
    // this.log.info(
    //   "Started scanning for AM43 blinds, stopping in " + timeout + " seconds"
    // )
    // noble.startScanning([AM43_SERVICE_ID], false, (error) => {
    //   if (error) this.log.error(error)
    // })
    // setTimeout(() => {
    //   this.isScanning = false
    //   noble.stopScanning((error) => {
    //     if (!error) {
    //       const devices = this.accessories.filter(
    //         (accessory) => accessory.am43device != null
    //       )
    //       this.log.info(
    //         "Stopped searching for AM43 Blinds, found " +
    //           devices.length +
    //           " devices"
    //       )
    //       return
    //     }
    //     this.log.error("Failed to stop searching for AM43 blinds")
    //   })
    // }, timeout * 1000)
  }

  configureAccessory(accessory) {
    accessory.updateReachability(false)
    this.configureServicesOnAccessory(accessory)
    this.configurePropertiesOnAccessory(accessory)
    this.accessories.push(accessory)
  }

  createAccessory(device, uuid) {
    const accessory = new this.api.platformAccessory(device.name, uuid)
    accessory.am43device = device
    this.configureServicesOnAccessory(accessory)
    this.configurePropertiesOnAccessory(accessory)
    return accessory
  }

  configurePropertiesOnAccessory(accessory) {
    accessory.lastPositionUpdate = null
    accessory.secondsSinceLastPositionUpdate = function () {
      return this.lastPositionUpdate
        ? Math.floor((Date.now() - this.lastPositionUpdate) / 1000)
        : 60 * 60
    }

    accessory.log = this.log

    accessory.hapInteractionTimeout =
      this.configJSON[CONFIG_KEY_HAP_INTERACTION_TIMEOUT] != undefined
        ? this.configJSON[CONFIG_KEY_HAP_INTERACTION_TIMEOUT]
        : DEFAULT_HAP_INTERACTION_TIMEOUT
    accessory.lastHAPInteraction = null // The last time the homekit accessory procotol tried to interact with the device, this is used to disconnect the device to conserve power.
    accessory.secondsSinceLastHAPInteraction = () => {
      return accessory.lastHAPInteraction
        ? Math.floor((Date.now() - accessory.lastHAPInteraction) / 1000)
        : 0 // If HomeKit hasn't interacted yet we keep the device connected.
    }
    accessory.disconnectIfUninteracted = () => {
      if (!accessory.am43device.isConnected) {
        return
      }
      if (
        accessory.hapInteractionTimeout > 0 &&
        accessory.secondsSinceLastHAPInteraction() >=
          accessory.hapInteractionTimeout
      ) {
        this.log["info"](
          `Disconnecting AM43 ${accessory.displayName} due to HAP inactivity`
        )
        accessory.am43device.disconnectAsync()
      }
    }
    accessory.checkForHAPInteractionTimeout = () => {
      // if (!accessory.am43device.isConnected) {
      //   return
      // }
      // if (
      //   accessory.hapInteractionTimeout > 0 &&
      //   accessory.secondsSinceLastHAPInteraction() >=
      //     accessory.hapInteractionTimeout
      // ) {
      //   accessory.log.debug(
      //     "HAP interaction timeout reached, starting " +
      //       HAP_NO_INTERACTION_GRACE_PERIOD +
      //       " second grace period"
      //   )
      //   // We wait a few seconds before disconnecting the device because updating the device's characteristics might trigger an automation.
      //   setTimeout(() => {
      //     accessory.disconnectIfUninteracted()
      //   }, HAP_NO_INTERACTION_GRACE_PERIOD * 1000)
      // }
    }

    accessory.updateInformation = async () => {
      if (!accessory.am43device) return

      this.log["info"](
        `Updating device information for ${accessory.displayName} from poll`
      )
      await sleep(200)
      await accessory.am43device.updatePositionAsync()
      await sleep(200)
      await accessory.am43device.updateBatteryStatusAsync()
    }
  }

  configureDeviceOnAccessory(accessory, device) {
    accessory.updateReachability(true)
    accessory.am43device = device

    accessory.context.am43 = {
      ...accessory.context.am43,
      id: device.id,
      address: device.address,
    }

    if (accessory.context.am43.lastPosition) {
      accessory.am43device.position = accessory.context.am43.lastPosition
    }
    if (accessory.context.am43.lastBatteryPercentage) {
      accessory.am43device.batteryPercentage =
        accessory.context.am43.lastBatteryPercentage
    }

    device.on("direction", (direction) => {
      const { targetPosition, position } = accessory.am43device
      this.log["info"](
        `${accessory.displayName}: Notifying of new direction (0 down, 1 up): ${direction}`
      )
      let target = targetPosition ? targetPosition : position
      accessory.windowCoveringService
        .getCharacteristic(this.api.hap.Characteristic.PositionState)
        .updateValue(direction)
      if (direction === 2) {
        accessory.windowCoveringService
          .getCharacteristic(this.api.hap.Characteristic.CurrentPosition)
          .updateValue(100 - accessory.am43device.position)
        accessory.windowCoveringService
          .getCharacteristic(this.api.hap.Characteristic.TargetPosition)
          .updateValue(100 - target)
      }
    })

    device.on("targetPosition", (position) => {
      var targetPosition =
        position == null ? accessory.am43device.position : position
      this.log["info"](
        `${accessory.displayName}: Notifying of new target position:  ${
          100 - targetPosition
        }`
      )
      accessory.windowCoveringService
        .getCharacteristic(this.api.hap.Characteristic.TargetPosition)
        .updateValue(100 - targetPosition)
    })

    device.on("position", (position) => {
      position = 100 - position // In AM43 Devices 100% means fully closed, but in HomeKit 100% means fully opened
      this.log["info"](
        `${accessory.displayName}: Notifying of new position: ${position}`
      )
      accessory.lastPositionUpdate = Date.now()
      accessory.windowCoveringService
        .getCharacteristic(this.api.hap.Characteristic.CurrentPosition)
        .updateValue(100 - position)
      if (device.direction === 2) {
        accessory.windowCoveringService
          .getCharacteristic(this.api.hap.Characteristic.TargetPosition)
          .updateValue(100 - position)
      }

      accessory.checkForHAPInteractionTimeout()
    })

    device.on("batteryPercentage", (percentage) => {
      this.log["info"](
        `${accessory.displayName}: Notifying of new battery percentage: ${percentage}`
      )
      accessory.batteryService
        .getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
        .updateValue(percentage)
      accessory.batteryService
        .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
        .updateValue(percentage <= 10)

      accessory.checkForHAPInteractionTimeout()
    })

    const pollInterval =
      this.configJSON[CONFIG_KEY_POLL_INTERVAL] != undefined
        ? this.configJSON[CONFIG_KEY_POLL_INTERVAL]
        : DEFAULT_POLL_INTERVAL
    if (pollInterval >= MINIMUM_POLL_INTERVAL) {
      setTimeout(() => {
        poll(() => accessory.updateInformation(), pollInterval * 1000)
      }, pollInterval * 1000)
    }
  }

  configureServicesOnAccessory(accessory) {
    this.configureWindowCoveringServiceOnAccessory(accessory)
    this.configureInformationServiceOnAccessory(accessory)
    this.configureBatteryServiceOnAccessory(accessory)
  }

  configureInformationServiceOnAccessory(accessory) {
    const service =
      accessory.getService(this.api.hap.Service.AccessoryInformation) ||
      accessory.addService(this.api.hap.Service.AccessoryInformation)

    service
      .getCharacteristic(this.api.hap.Characteristic.Manufacturer)
      .updateValue("renssies")

    service
      .getCharacteristic(this.api.hap.Characteristic.Model)
      .updateValue("AM43")

    service
      .getCharacteristic(this.api.hap.Characteristic.Name)
      .updateValue(`Blind: ${accessory.displayName}`)

    service
      .getCharacteristic(this.api.hap.Characteristic.SerialNumber)
      .on("get", (callback) => {
        if (!accessory.am43device) {
          callback("No device found please try again", null)
          return
        }
        return callback(null, accessory.am43device.id)
      })

    service
      .getCharacteristic(this.api.hap.Characteristic.FirmwareRevision)
      .on("get", (callback) => callback(null, this.packageJSON.version))

    accessory.informationService = service
  }

  configureBatteryServiceOnAccessory(accessory) {
    const service =
      accessory.getService(this.api.hap.Service.BatteryService) ||
      accessory.addService(this.api.hap.Service.BatteryService)

    service
      .getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
      .on("get", (callback) => {
        if (!accessory.am43device) {
          callback("No device found please try again", null)
          return
        }
        accessory.am43device.updateBatteryStatusAsync()
        return callback(null, accessory.am43device.batteryPercentage)
      })

    service
      .getCharacteristic(this.api.hap.Characteristic.ChargingState)
      .updateValue(0)

    service
      .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
      .on("get", (callback) => {
        if (!accessory.am43device) {
          callback("No device found please try again", null)
          return
        }
        return callback(null, accessory.am43device.batteryPercentage <= 10)
      })

    accessory.batteryService = service
  }

  configureWindowCoveringServiceOnAccessory(accessory) {
    const service =
      accessory.getService(this.api.hap.Service.WindowCovering) ||
      accessory.addService(this.api.hap.Service.WindowCovering)

    service
      .getCharacteristic(this.api.hap.Characteristic.CurrentPosition)
      .on("get", (callback) => {
        if (!accessory.am43device) {
          this.scanForDevices()
          callback("No device found please try again", null)
          return
        }
        accessory.lastHAPInteraction = Date.now()

        if (
          accessory.secondsSinceLastPositionUpdate() >
            POSITION_UPDATE_INTERVAL ||
          !accessory.am43device.isConnected
        ) {
          this.log["info"](
            `${accessory.displayName}: Requesting position update`
          )
          accessory.am43device.updatePositionAsync()
        }

        const position = 100 - accessory.am43device.position // In AM43 Devices 100% means fully closed, but in HomeKit 100% means fully opened
        this.log["info"](
          `${accessory.displayName}: Reporting position: ${position}`
        )
        return callback(null, position)
      })

    service
      .getCharacteristic(this.api.hap.Characteristic.TargetPosition)
      .on("get", (callback) => {
        if (!accessory.am43device) {
          callback("No device found please try again", null)
          return
        }
        accessory.lastHAPInteraction = Date.now()

        var targetPosition = accessory.am43device.targetPosition
          ? accessory.am43device.targetPosition
          : accessory.am43device.position
        targetPosition = 100 - targetPosition
        this.log["info"](
          `${accessory.displayName}: Reporting target position: ${targetPosition}`
        )
        return callback(null, targetPosition)
      })
      .on("set", async (value, callback) => {
        if (!accessory.am43device) {
          callback("No device found please try again")
          return
        }
        accessory.lastHAPInteraction = Date.now()

        const targetPosition = 100 - value // In AM43 Devices 100% means fully closed, but in HomeKit 100% means fully opened
        this.log["info"](
          `${accessory.displayName}: setting target position: ${targetPosition}`
        )
        try {
          await accessory.am43device.setPositionAsync(targetPosition, true)
          setTimeout(() => {
            this.log["info"](
              `${accessory.displayName}: Checking for HAP interaction timeout after setting target position`
            )
            accessory.checkForHAPInteractionTimeout()
          }, accessory.hapInteractionTimeout * 1000 + 500) // Wait until the hap interaction timeout to check.
          return callback(null)
        } catch (error) {
          callback(error)
        }
      })

    service
      .getCharacteristic(this.api.hap.Characteristic.PositionState)
      .on("get", (callback) => {
        if (!accessory.am43device) {
          callback("No device found please try again", null)
          return
        }
        accessory.lastHAPInteraction = Date.now()
        this.log["info"](
          `${accessory.displayName}: Reporting direction: ${accessory.am43device.direction}`
        )
        callback(null, accessory.am43device.direction)
      })

    service
      .getCharacteristic(this.api.hap.Characteristic.HoldPosition)
      .on("set", async (boolean, callback) => {
        if (!accessory.am43device) {
          callback("No device found please try again")
          return
        }
        accessory.lastHAPInteraction = Date.now()
        await accessory.am43device.stopAsync()
        callback(null)
      })

    accessory.windowCoveringService = service
  }

  identify(callback) {
    this.log.info("Identifying AM43 Blinds platform")
    callback()
  }
}

module.exports = AM43Platform
