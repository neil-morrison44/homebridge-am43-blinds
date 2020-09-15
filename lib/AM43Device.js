// @ts-check

const {
  AM43_COMMAND_PREFIX,
  AM43_COMMAND_ID_GET_POSITION,
  AM43_COMMAND_ID_GET_LIGHTSENSOR,
  AM43_COMMAND_ID_GET_BATTERYSTATUS,
  AM43_NOTIFY_POSITION,
  AM43_COMMAND_ID_SET_MOVE,
  AM43_COMMAND_ID_SET_POSITION,
  AM43_RESPONSE_ACK,
  AM43_RESPONSE_NACK,
  AM43_SERVICE_ID,
  AM43_CHARACTERISTIC_ID,
  AM43_MOVE_OPEN,
  AM43_MOVE_CLOSE,
  AM43_MOVE_STOP,
} = require("./variables/device")

const EventEmitter = require("events").EventEmitter
const retry = require("async-await-retry")
const { sleep } = require("./utils")

class AM43Device extends EventEmitter {
  constructor(peripheral, log) {
    super()

    this.peripheral = peripheral
    if (peripheral.localName) {
      this.name = peripheral.localName
    } else if (peripheral.advertisement.localName) {
      this.name = peripheral.advertisement.localName
    } else if (peripheral.address) {
      this.name = peripheral.address
    } else {
      let name = "AM43 Blind"
      if (peripheral.id) {
        name += " "
        name += peripheral.id
      }
      this.name = name
    }
    if (peripheral.id) {
      this.id = peripheral.id
    } else if (peripheral.uuid) {
      this.id = peripheral.uuid
    } else if (peripheral.address) {
      this.id = peripheral.address
    } else {
      this.id = this.name
    }
    this.address = peripheral.address

    let addressDesc =
      this.peripheral.address != null
        ? this.peripheral.address
        : this.peripheral.id
    this.description = this.name + " (" + addressDesc + ")"

    this.isConnected = false
    this.peripheral.on("connect", () => {
      this.debugLog(`Device connected: ${this.name}`)
      // this.isConnected = true
    })
    this.peripheral.on("disconnect", () => {
      this.debugLog(`Device disconnected: ${this.name}`)
      this.blindsControlCharacteristic = null
      this.isConnected = false
    })
    this.blindsControlCharacteristic = null
    this.position = 0
    this.targetPosition = null
    this.direction = 2 // 0: Down/Decreating, 1: Up/Increasing, 2: Stopped
    this.batteryPercentage = 50
    this.log = log
    this.lastCommandTimestamp = Date.now()

    this.lastFewPositions = []
  }

  debugLog(info) {
    this.log(this.name, info)
  }

  setBlindsControlCharacteristic(characteristic) {
    this.connectingPromise = null
    this.discoveringPromise = null

    if (this.blindsControlCharacteristic === characteristic) return
    this.blindsControlCharacteristic = characteristic
    this.blindsControlCharacteristic.on("data", (data) => {
      this.debugLog("--------Notification--------")
      const dataArray = new Uint8Array(data)
      this.debugLog(`Data received:` + dataArray)
      let percentage = null

      switch (data[1]) {
        case AM43_COMMAND_ID_GET_POSITION:
          this.debugLog("Position update received")
          percentage = parseInt(dataArray[5])
          this.debugLog(`Closed Percentage ${percentage}`)
          this.position = percentage
          this.lastFewPositions.unshift(this.position)
          this.lastFewPositions.length = Math.min(
            5,
            this.lastFewPositions.length
          )
          this.emit("position", this.position)
          break

        case AM43_COMMAND_ID_GET_LIGHTSENSOR:
          this.debugLog("light sensor update received")
          percentage = parseInt(dataArray[4])
          this.debugLog(`Light level ${percentage}`)
          this.emit("lightLevel", percentage)
          break

        case AM43_COMMAND_ID_GET_BATTERYSTATUS:
          this.debugLog("Battery Status update received")
          percentage = parseInt(dataArray[7])
          this.debugLog(`Battery Percentage ${percentage}`)
          this.batteryPercentage = percentage
          this.emit("batteryPercentage", this.batteryPercentage)
          break

        case AM43_NOTIFY_POSITION:
          this.debugLog("Position notify received")
          percentage = parseInt(dataArray[4])
          this.debugLog(`Closed Percentage ${percentage}`)
          this.position = percentage
          this.lastFewPositions.unshift(this.position)
          this.lastFewPositions.length = Math.min(
            5,
            this.lastFewPositions.length
          )
          this.emit("position", this.position)
          break

        case AM43_COMMAND_ID_SET_MOVE:
          this.debugLog("Set move notify received")
          if (dataArray[3] == AM43_RESPONSE_ACK) {
            this.debugLog("Set move acknowledged")
          } else if (dataArray[3] == AM43_RESPONSE_NACK) {
            this.debugLog("Set move denied")
          }
          break

        case AM43_COMMAND_ID_SET_POSITION:
          this.debugLog("Set position notify received")
          if (dataArray[3] == AM43_RESPONSE_ACK) {
            this.debugLog("Set position acknowledged")
          } else if (dataArray[3] == AM43_RESPONSE_NACK) {
            this.debugLog("Set position denied")
          }
          break

        default:
          break
      }

      if (this.targetPosition != null && this.position != null) {
        let direction = this.targetPosition < this.position ? 1 : 0
        let targetPosition = this.targetPosition

        this.debugLog(
          `Checking Target position, position: ${this.position}%, target: ${this.targetPosition}%`
        )

        if (this.position == this.targetPosition || this.hasStopped()) {
          this.debugLog(`Target position reached`)
          targetPosition = null
        }
        if (targetPosition == null) {
          direction = 2
        }
        if (direction != this.direction) {
          this.direction = direction
          this.emit("direction", this.direction)
        }
        if (targetPosition != this.targetPosition) {
          this.targetPosition = targetPosition
          this.emit("targetPosition", this.targetPosition)
        }
      }
    })

    this.blindsControlCharacteristic.subscribe((error) => {
      if (error) {
        this.debugLog("Failed to subsribe to notifications")
      } else {
        this.debugLog("Subscribed to notifications")
      }
    })
  }

  hasStopped() {
    this.debugLog(`checking if stopped ${this.lastFewPositions}`)
    if (this.lastFewPositions.length < 5) return false
    return this.lastFewPositions.every((v) => v === this.lastFewPositions[0])
  }

  async prepareAsync() {
    if (!this.isConnected) await this.reconnect()
    await this.updatePositionAsync()
  }

  attemptConnection() {
    return new Promise((resolve, reject) => {
      let hasResolved = false
      let hasDisconnectedAlready = false
      // attempt to handle situations where it "connects" then immediately
      // (within 3 seconds) disconnects by waiting to see if the connection is real
      this.peripheral.once("connect", () => {
        setTimeout(() => {
          if (hasDisconnectedAlready) return
          hasResolved = true
          this.debugLog("Has resolved a connection")
          resolve()
        }, 3e3)
      })
      this.peripheral.once("disconnect", () => {
        if (hasResolved) return
        hasDisconnectedAlready = true
        this.debugLog("Has rejected a connection")
        reject(new Error("Has rejected a connection"))
      })
      this.peripheral.connectAsync()

      // set a timeout of 5 seconds, real connections seem to take around 2
      setTimeout(async () => {
        if (!hasResolved && !hasDisconnectedAlready) {
          this.hasResolved = true
          this.hasDisconnectedAlready = true
          await this.disconnectAsync()
          this.debugLog("Has rejected a connection (timeout)")
          reject(new Error("Has rejected a connection (timeout)"))
        }
      }, 5e3)
    })
  }

  retryConnecting(wait = 250, maxAttempts = 5) {
    return new Promise(async (resolve, reject) => {
      let attempt = 1
      while (attempt < maxAttempts) {
        try {
          const result = await this.attemptConnection()
          resolve(result)
          return
        } catch (err) {
          this.debugLog(err)
          attempt += 1
          await sleep(wait)
        }
      }

      reject(new Error("Failed to connect"))
    })
  }

  async reconnect() {
    this.debugLog(`Attempting to connect... ${Boolean(this.connectingPromise)}`)
    if (this.connectingPromise) return this.connectingPromise

    this.connectingPromise = this.retryConnecting()
    await this.connectingPromise
    this.debugLog("apparently I've connected?")
    this.isConnected = true

    this.connectingPromise = null
    return this.connectingPromise
  }

  async serviceDiscoveryAsync() {
    if (this.discoveringPromise) return this.discoveringPromise
    this.debugLog("discovering services...")
    this.discoveringPromise = this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [AM43_SERVICE_ID],
      [AM43_CHARACTERISTIC_ID]
    )
    const { characteristics } = await this.discoveringPromise
    this.setBlindsControlCharacteristic(characteristics[0])
    this.debugLog("discovering services complete")
    return this.discoveringPromise
  }

  async disconnectAsync() {
    this.isConnected = false
    await this.peripheral.disconnectAsync()
  }

  async enableNotificationsAsync() {
    try {
      await this.blindsControlCharacteristic.subscribeAsync()
      this.debugLog("Subscribed to notifications")
    } catch (e) {
      this.debugLog("Failed to subsribe to notifications")
    }
  }

  async setPositionAsync(position, trackPosition) {
    this.lastFewPositions = []
    this.targetPosition = position
    await this.sendCommandAsync(AM43_COMMAND_ID_SET_POSITION, [position])
    if (trackPosition == true) {
      this.trackCurrentPosition()
    }
  }

  trackCurrentPosition() {
    setTimeout(async () => {
      await this.updatePositionAsync()
      if (this.targetPosition != null) {
        this.trackCurrentPosition()
      }
    }, 1000)
  }

  async openAsync() {
    this.targetPosition = 0
    this.lastFewPositions = []
    this.direction = 1
    await this.sendCommandAsync(AM43_COMMAND_ID_SET_MOVE, [AM43_MOVE_OPEN])
    this.emit("direction", this.direction)
    this.emit("targetPosition", this.targetPosition)
  }

  async closeAsync() {
    this.targetPosition = 100
    this.lastFewPositions = []
    this.direction = 0
    await this.sendCommandAsync(AM43_COMMAND_ID_SET_MOVE, [AM43_MOVE_CLOSE])
    this.emit("direction", this.direction)
    this.emit("targetPosition", this.targetPosition)
  }

  async stopAsync() {
    this.targetPosition = null
    this.direction = 2
    await this.sendCommandAsync(AM43_COMMAND_ID_SET_MOVE, [AM43_MOVE_STOP])
    this.emit("direction", this.direction)
    this.emit("targetPosition", this.targetPosition)
  }

  async updatePositionAsync() {
    await this.sendCommandAsync(AM43_COMMAND_ID_GET_POSITION, [0x1])
  }

  async updateBatteryStatusAsync() {
    await this.sendCommandAsync(AM43_COMMAND_ID_GET_BATTERYSTATUS, [0x1])
  }

  async updateLightSensorAsync() {
    await this.sendCommandAsync(AM43_COMMAND_ID_GET_LIGHTSENSOR, [0x1])
  }

  async sendCommandAsync(commandID, data) {
    if (!this.isConnected) await this.reconnect()

    this.lastCommandTimestamp = Date.now()
    this.debugLog("--------Command--------")
    this.debugLog(`Sending command to device: ${this.id}`)
    const bufferArray = new Uint8Array(data.length + 8)
    const startPackage = AM43_COMMAND_PREFIX
    for (let index = 0; index < startPackage.length; index++) {
      bufferArray[index] = startPackage[index]
    }
    bufferArray[5] = commandID
    const uIntData = Uint8Array.from(data)
    bufferArray[6] = uIntData.length
    let bufferIndex = 7
    for (let index = 0; index < uIntData.length; index++) {
      bufferArray[bufferIndex] = uIntData[index]
      bufferIndex++
    }
    bufferArray[bufferIndex] = this.calculateCommandChecksum(bufferArray)
    bufferIndex++

    const buffer = Buffer.from(bufferArray.buffer)
    let hexString = buffer.toString("hex")
    this.debugLog(`Sending command: ${hexString}`)

    if (!this.blindsControlCharacteristic) {
      await sleep(250)
      await this.serviceDiscoveryAsync()
    }

    await this.blindsControlCharacteristic.writeAsync(buffer, true)
  }

  calculateCommandChecksum(bufferArray) {
    let checksum = 0
    for (let i = 0; i < bufferArray.length - 1; i++) {
      checksum = checksum ^ bufferArray[i]
    }
    checksum = checksum ^ 0xff
    return checksum
  }
}

module.exports = {
  AM43Device,
}
