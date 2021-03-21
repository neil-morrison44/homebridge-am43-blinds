import React, { Fragment, useEffect, useState } from "react"
import { useHomebridgeConfig } from "../hooks/useHomebridgeConfig"
import MotorIcon from "./motorIcon"

const MotorInfo = ({ deviceId }) => {

  const [device, setDevice] = useState(null)
  const [newName, setNewName] = useState(null)
  const { config, updateConfig, saveConfig } = useHomebridgeConfig()

  console.log(config)

  const isInAllowedDevices = (device && config) && (config[0].allowed_devices.includes(device.address))

  const removeFromAllowedDevices = async () => {
    await updateConfig([{ ...config[0], allowed_devices: config[0].allowed_devices.filter((address) => address !== device.address) }])
  }

  const addToAllowedDevices = async () => {
    await updateConfig([{ ...config[0], allowed_devices: [...config[0].allowed_devices, device.address] }])
  }

  useEffect(() => {
    homebridge.showSpinner()
    homebridge.request('/connect_to_device', { device_id: deviceId }).then(
      (deviceResult) => {
        homebridge.hideSpinner()
        console.log(deviceResult)
        setDevice(deviceResult)
      }
    )
  }, [])

  useEffect(() => setNewName(device?.localName || null), [device])

  const submitNewName = () => {
    homebridge.request('/rename_device', { device_id: deviceId, new_name: newName })
  }

  return <div className="card-body d-flex">
    <div className="mr-3">
      <MotorIcon />
    </div>
    {device &&
      <div className="w-100">
        <div className="input-group mb-3">
          <div className="input-group-prepend">
            <span className="input-group-text" id="motor-name">Name</span>
          </div>
          <input value={newName} onChange={({ target }) => setNewName(target.value)} type="text" className="form-control" placeholder="Motor Name" aria-label="local name" aria-describedby="motor-name" />
          {(device.localName !== newName && newName?.length > 0) &&
            <div className="input-group-append">
              <button type="button" onClick={submitNewName} className="btn-outline-secondary">Update</button>
            </div>
          }
        </div>

        <div className="input-group mb-3">
          <div className="input-group-prepend">
            <span className="input-group-text" id="motor-address">Address</span>
          </div>
          <input value={device.address} type="text" disabled className="form-control" aria-label="local name" aria-describedby="motor-address" />
        </div>

        {config && <button type="button" className={`btn ${isInAllowedDevices ? "btn-danger" : "btn-secondary"}`} onClick={isInAllowedDevices ? removeFromAllowedDevices : addToAllowedDevices}>{isInAllowedDevices ? "Remove from" : "Add to"} Allowed List (on save)</button>}
      </div>
    }
    {!device && <div><div className="alert alert-secondary" role="alert">
      Attempting to connect to motor...
    </div></div>}
  </div>
}

export default MotorInfo
