"use strict";

var tesla = require('teslams');
var util = require('util');
var cacheManager = require('cache-manager');
var memoryCache = cacheManager.caching({ store: 'memory', max: 100, ttl: 30/*seconds*/ });

var Accessory, Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform("homebridge-tesla-climate-control", "Tesla", TeslaPlatform, false);
}

function TeslaPlatform(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config;

    this.name = config.name;

    this.username = config["username"];
    this.password = config["password"];
    this.authToken = config["authToken"];
}

TeslaPlatform.prototype.accessories = function (callback) {
    let accessories = [];

    if (this.authToken != undefined) {
        var expiresAt = new Date((this.authToken.created_at * 1000) + (this.authToken.expires_in * 1000))
        this.log("Supplied token expires on " + expiresAt);
        if (expiresAt < Date.now())
            this.authToken = undefined;
    }

    var accessToken = undefined;
    if (this.authToken != undefined) {
        accessToken = this.authToken.access_token;
    }

    tesla.all({ token: accessToken, email: this.username, password: this.password }, function (err, response, body) {

        if (err) {
            this.log("Error logging into Tesla: " + err);
            callback(err);
            return;
        }

        var vehicles = JSON.parse(body).response;

        if (vehicles.length && vehicles.length < 0) {
            this.log("No vehicles were found");

            return callback(new Error("No vehicles were found."));
        }

        for (var i = 0; i < vehicles.length; i++) {
            var vehicle = vehicles[i];
            var uuid = UUIDGen.generate(vehicle.id_s);
            accessories.push(new Thermostat(this.log, this.config, vehicle));
        }

        return callback(accessories);
    }.bind(this));
}

function Thermostat(log, config, vehicleConfig) {
    this.log = log;
    this.name = vehicleConfig.display_name + " Climate Control";
    this.vehicleConfig = vehicleConfig
    this.maxTemp = config.maxTemp || 32;
    this.minTemp = config.minTemp || 16;

    this.vehicleID = vehicleConfig.id_s;

    this.log("Tesla Thermostat instantiated");
    this.log("    Vehicle name: " + this.vehicleConfig.display_name);
    this.log("    Vehicle ID: " + this.vehicleID);

    //this.lockService = new Service.LockMechanism(this.name);
    //this.lockService
    // .getCharacteristic(Characteristic.LockCurrentState)
    // .on('get', this.getLockState.bind(this));
    //this.lockService
    // .getCharacteristic(Characteristic.LockTargetState)
    // .on('get', this.getLockState.bind(this))
    // .on('set', this.setLockState.bind(this));
    this.temperatureDisplayUnits = Characteristic.TemperatureDisplayUnits.CELSIUS;
    this.currentTemperature = 19;
    this.currentRelativeHumidity = 0.70;
    this.currentHeatingCoolingState = Characteristic.CurrentHeatingCoolingState.AUTO;
    this.targetTemperature = 21;
    this.targetRelativeHumidity = 0.5;
    this.heatingThresholdTemperature = 25;
    this.coolingThresholdTemperature = 5;
    this.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.AUTO;
    this.service = new Service.Thermostat(this.name);
}

Thermostat.prototype = {
    //Start
    identify: function (callback) {
        this.log("Identify requested!");
        callback(null);
    },
    getClimateState: function (cacheCallback) {
        memoryCache.wrap("climateState_" + this.vehicleConfig.id_s, function (callback) {
            //this.log("Retrieving current Climate State for vehicle " + id);

            tesla.get_climate_state(this.vehicleConfig.id_s, function (state) {
                callback(state);
            }.bind(this));
        }.bind(this), cacheCallback);
    },
    getCurrentHeatingCoolingState: function (callback) {
            this.getClimateState(function (state) {

                if (state) {
                    if (state.is_climate_on == true)
                        this.currentHeatingCoolingState = Characteristic.CurrentHeatingCoolingState.HEAT;
                    else
                        this.currentHeatingCoolingState = Characteristic.CurrentHeatingCoolingState.OFF;
                }
                else
                {
                    //this.log("getCurrentHeatingCoolingState FAILED to retrieve state!")
                    this.currentHeatingCoolingState = Characteristic.CurrentHeatingCoolingState.OFF;
                }

                callback(null, this.currentHeatingCoolingState);
            }.bind(this));
    },
    getTargetHeatingCoolingState: function (callback) {
            this.getClimateState(function (state) {
                if (state.is_climate_on == true)
                    this.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.AUTO;
                else
                    this.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.OFF;

                callback(null, this.targetHeatingCoolingState);
            }.bind(this));
    },
    setTargetHeatingCoolingState: function (value, callback) {
        if (value === undefined) {
            callback();
            return;
        }

            var climateState;
            switch (value) {
                case Characteristic.TargetHeatingCoolingState.HEAT:
                case Characteristic.TargetHeatingCoolingState.AUTO:
                case Characteristic.TargetHeatingCoolingState.COOL:
                    climateState = "start";
                    break;
                default:
                    climateState = "stop";
                    break;
            }
            tesla.auto_conditioning({ id: this.vehicleID, climate: climateState }, function (response) {
                if (response.result == true) {

                    this.targetHeatingCoolingState = value;

                    callback(null);
                }
                else {
                    this.log("Error setting climate state: " + util.inspect(arguments));
                    callback(new Error("Error setting climate state."));
                }
            }.bind(this));
    },
    getCurrentTemperature: function (callback) {
            this.getClimateState(function (state) {
                if (state.inside_temp != undefined)
                    this.currentTemperature = state.inside_temp;
                else
                    this.currentTemperature = 0;

                callback(null, this.currentTemperature);
            }.bind(this));
    },
    getTargetTemperature: function (callback) {
            this.getClimateState(function (state) {
                this.targetTemperature = state.driver_temp_setting;

                callback(null, this.targetTemperature);
            }.bind(this));
    },
    setTargetTemperature: function (value, callback) {
            tesla.set_temperature({ id: this.vehicleID, dtemp: value }, function (state) {
                this.log(state);

                this.targetTemperature = value;

                callback(null, this.targetTemperature);
            }.bind(this));
    },
    getTemperatureDisplayUnits: function (callback) {
        //this.log("getTemperatureDisplayUnits:", this.temperatureDisplayUnits);
        var error = null;
        callback(error, this.temperatureDisplayUnits);
    },
    setTemperatureDisplayUnits: function (value, callback) {
        //this.log("setTemperatureDisplayUnits from %s to %s", this.temperatureDisplayUnits, value);
        this.temperatureDisplayUnits = value;
        var error = null;
        callback(error);
    },
    getHeatingThresholdTemperature: function (callback) {
        //this.log("getHeatingThresholdTemperature :", this.heatingThresholdTemperature);
        var error = null;
        callback(error, this.heatingThresholdTemperature);
    },
    getName: function (callback) {
        //this.log("getName :", this.name);
        var error = null;
        callback(error, this.name);
    },
    getServices: function () {
        // you can OPTIONALLY create an information service if you wish to override
        // the default values for things like serial number, model, etc.
        var informationService = new Service.AccessoryInformation();
        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Tesla Climate Control")
            .setCharacteristic(Characteristic.Model, "Tesla")
            .setCharacteristic(Characteristic.SerialNumber, "NA");
        // Required Characteristics
        this.service
            .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .on('get', this.getCurrentHeatingCoolingState.bind(this));
        this.service
            .getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .on('get', this.getTargetHeatingCoolingState.bind(this))
            .on('set', this.setTargetHeatingCoolingState.bind(this));
        this.service
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', this.getCurrentTemperature.bind(this));
        this.service
            .getCharacteristic(Characteristic.TargetTemperature)
            .on('get', this.getTargetTemperature.bind(this))
            .on('set', this.setTargetTemperature.bind(this));
        this.service
            .getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .on('get', this.getTemperatureDisplayUnits.bind(this))
            .on('set', this.setTemperatureDisplayUnits.bind(this));
        this.service
            .getCharacteristic(Characteristic.HeatingThresholdTemperature)
            .on('get', this.getHeatingThresholdTemperature.bind(this));
        this.service
            .getCharacteristic(Characteristic.Name)
            .on('get', this.getName.bind(this));
        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({
                minValue: -30,
                maxValue: 45,
                minStep: 1
            });
        this.service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({
                minValue: this.minTemp,
                maxValue: this.maxTemp,
                minStep: 0.5
            });

        return [informationService, this.service];
    }
};
