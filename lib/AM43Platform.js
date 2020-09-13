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
      this.log(
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

  disconnectUnusedDevices() {
    const interactionTimeout =
      this.configJSON[CONFIG_KEY_HAP_INTERACTION_TIMEOUT] !== null
        ? this.configJSON[CONFIG_KEY_HAP_INTERACTION_TIMEOUT]
        : DEFAULT_HAP_INTERACTION_TIMEOUT

    this.log("interactionTimeout " + interactionTimeout)
    this.accessories.forEach((accessory) => {
      if (!accessory.am43device) return

      const timeSinceInteraction = Date.now() - accessory.lastCommandTimestamp
      this.log("timeSinceInteraction " + timeSinceInteraction)
      if (interactionTimeout > 0 && timeSinceInteraction > interactionTimeout) {
        this.log(`${accessory.displayName}: disconnecting unused device`)
        accessory.context.am43.lastPosition = accessory.am43device.position
        accessory.context.am43.lastBatteryPercentage =
          accessory.am43device.batteryPercentage
        accessory.am43device.disconnectAsync()
      }
    })

    setTimeout(() => this.disconnectUnusedDevices(), 20e3)
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
    accessory.updateInformation = async () => {
      if (!accessory.am43device) return

      this.log(
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

    const updateTargetPosition = (target) => {
      this.log(
        `${accessory.displayName}: Notifying of target position ${target}%`
      )
      accessory.windowCoveringService
        .getCharacteristic(this.api.hap.Characteristic.TargetPosition)
        .updateValue(target)
    }

    const updateCurrentPosition = (position) => {
      this.log(
        `${accessory.displayName}: Notifying of current position ${position}%`
      )
      accessory.windowCoveringService
        .getCharacteristic(this.api.hap.Characteristic.CurrentPosition)
        .updateValue(position)
    }

    const updatePositionState = (direction) => {
      this.log(
        `${accessory.displayName}: Notifying of current direction ${direction}`
      )
      accessory.windowCoveringService
        .getCharacteristic(this.api.hap.Characteristic.PositionState)
        .updateValue(direction)
    }

    device.on("direction", (direction) => {
      const { targetPosition, position } = accessory.am43device
      this.log(
        `${accessory.displayName}: Notifying of new direction (0 down, 1 up): ${direction}`
      )
      let target = targetPosition ? targetPosition : position
      updatePositionState(direction)
      if (direction === 2) {
        updateCurrentPosition(100 - position)
        updateTargetPosition(100 - target)
      }
    })

    device.on("targetPosition", (position) => {
      const targetPosition =
        position == null ? accessory.am43device.position : position
      updateTargetPosition(100 - targetPosition)
    })

    device.on("position", (position) => {
      updateCurrentPosition(100 - position)
      if (device.direction === 2) {
        updateTargetPosition(100 - position)
      }
    })

    device.on("batteryPercentage", (percentage) => {
      this.log(
        `${accessory.displayName}: Notifying of new battery percentage: ${percentage}`
      )
      accessory.batteryService
        .getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
        .updateValue(percentage)
      accessory.batteryService
        .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
        .updateValue(percentage <= 10)
    })

    const pollInterval =
      this.configJSON[CONFIG_KEY_POLL_INTERVAL] != undefined
        ? this.configJSON[CONFIG_KEY_POLL_INTERVAL]
        : DEFAULT_POLL_INTERVAL
    if (pollInterval >= MINIMUM_POLL_INTERVAL) {
      setInterval(() => accessory.updateInformation(), pollInterval * 1000)
    }
    accessory.updateInformation()
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
        accessory.am43device.updatePositionAsync()
        const position = 100 - accessory.am43device.position // In AM43 Devices 100% means fully closed, but in HomeKit 100% means fully opened
        this.log(`${accessory.displayName}: Reporting position: ${position}`)
        return callback(null, position)
      })

    service
      .getCharacteristic(this.api.hap.Characteristic.TargetPosition)
      .on("get", (callback) => {
        if (!accessory.am43device) {
          callback("No device found please try again", null)
          return
        }
        const { targetPosition, position } = accessory.am43device
        const currentTargetPosition = targetPosition ? targetPosition : position
        this.log(
          `${accessory.displayName}: Reporting target position: ${
            100 - currentTargetPosition
          }`
        )
        return callback(null, 100 - currentTargetPosition)
      })
      .on("set", async (value, callback) => {
        if (!accessory.am43device) {
          callback("No device found please try again")
          return
        }

        const targetPosition = 100 - value // In AM43 Devices 100% means fully closed, but in HomeKit 100% means fully opened
        this.log(`${accessory.displayName}: setting target position: ${value}`)
        try {
          await accessory.am43device.setPositionAsync(targetPosition, true)
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
        this.log(
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
