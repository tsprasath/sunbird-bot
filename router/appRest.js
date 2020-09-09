const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
var https = require('https');
var http = require('http');
var fs = require('fs');
var redis = require('redis');
var LOG = require('./log/logger')
var literals = require('./config/literals')
var config = require('./config/config')
var chatflow = require('./config/chatflow')
var RasaCoreController = require('./controllers/rasaCoreController')
const telemetry = require('./api/telemetry/telemetry.js')
var UUIDV4 = require('uuid')
var date = new Date();
const parser = require('ua-parser-js')
const REDIS_KEY_PREFIX = "bot_";
const appBot = express()
//cors handling
appBot.use(cors());
//body parsers for requests
appBot.use(bodyParser.json());
appBot.use(bodyParser.urlencoded({ extended: false }))
var request = require("request");
const { data } = require('./log/logger');


// Redis is used as the session tracking store
const redisClient = redis.createClient(config.REDIS_PORT, config.REDIS_HOST);

// Route that receives a POST request to /bot
appBot.post('/bot', function (req, res) {
	handler(req, res, 'botclient')
})


console.log("time vefore calling /whatsapp", new Date().getTime())
appBot.post('/whatsapp', function (req, res) {
	console.log("time inside /whatsapp", new Date().getTime())
	handler(req, res, 'whatsapp')
})


function setData(req, res, channel) {
	if (channel == 'whatsapp') {
		var message = req.body.incoming_message[0].text_type.text;
		var deviceId = req.body.incoming_message[0].from;
		var channelId = channel;
		var userId = req.body.incoming_message[0].from;

		var uaspec = getUserSpec(req);
		return {
			message: message,
			customData: {
				userId: userId,
				deviceId: deviceId,
				channelId: channelId,
				uaspec: uaspec
			}
		}
	} else {
		var appId = req.body.appId + '.bot';
		var message = req.body.Body;
		var deviceId = req.body.From;
		var channelId = req.body.channel;
		var userId = req.body.userId ? req.body.userId : deviceId;
		var uaspec = getUserSpec(req);

		return {
			message: message,
			customData: {
				userId: userId,
				deviceId: deviceId,
				appId: appId,
				sessionId: '',
				channelId: channelId,
				uaspec: uaspec
			}
		}

	}
}

function handler(req, res, channel) {


	var chatflowConfig = req.body.context ? chatflow[req.body.context] ? chatflow[req.body.context] : chatflow.chatflow : chatflow.chatflow;
	redisSessionData = {};

	const data = setData(req, res, channel)



	if (!data.customData.deviceId) {
		sendResponse(data.customData.deviceId, res, "From attribute missing", 400);
	} else {
		redisClient.get(REDIS_KEY_PREFIX + data.customData.deviceId, (err, redisValue) => {
			if (redisValue != null) {
				// Key is already exist and hence assiging data which is already there at the posted key
				redisSessionData = JSON.parse(redisValue);
				data.customData.sessionId = redisSessionData.sessionID;
				var telemetryData = {};
				// all non numeric user messages go to bot
				if (isNaN(data.message)) {
					///Bot interaction flow
					freeFlowLogic (data, res, channel, chatflowConfig)
					
				} else {
					menuDrivenLogic(data, res, channel, chatflowConfig )
				}
			} else {

				// Implies new user. Adding data in redis for the key and also sending the WELCOME message
				
					var uuID = UUIDV4();
					userData = { sessionID: uuID, currentFlowStep: 'step1' };
					setRedisKeyValue(data.customData.deviceId, userData);
					data.customData.sessionId = uuID;
					telemetry.logSessionStart(data.customData);
				if (channel == "botclient") {
					telemetryData = createInteractionData({ currentStep: 'step1', responseKey: chatflowConfig['step1']['messageKey'] }, data.customData, false)
					telemetry.logInteraction(telemetryData)
					sendChannelResponse(res, chatflowConfig['step1']['messageKey'], channel, data.customData.userId);

				} else {
					if (isNaN(data.message)) {
						///Bot interaction flow
						freeFlowLogic (data, res, channel)
						
					} else {
						menuDrivenLogic(data, res, channel, chatflowConfig )
					}
				}
			}
		});
	}
}

function freeFlowLogic (data, res, channel, chatflowConfig) {
	RasaCoreController.processUserData(data, data.customData.userId, data.customData.deviceId, (err, resp) => {
		var response = '';
		if (err) {

			sendChannelResponse(data.customData.deviceId, res, channel, data.customData.userId, 'SORRY')
		} else {
			var responses = resp.res;
			if (responses && responses[0].text) {
				response = responses[0].text;
				telemetryData = createInteractionData(responses[0], data.customData, true);
			} else {
				responseKey = getErrorMessageForInvalidInput(responses[0], chatflowConfig);
				response = literals.message[responseKey];
				telemetryData = createInteractionData(responses[0], data.customData, true)
			}
			telemetry.logInteraction(telemetryData);
			if (channel == 'whatsapp') {
				sendResponseWhatsapp(response, data.customData.userId, "freeFlow")
			} else {
				sendResponse(res, response)
			}

		}
	});
	
}

function menuDrivenLogic (data, res, channel, chatflowConfig){
	var menuIntentKnown = false
	var currentFlowStep = redisSessionData.currentFlowStep;
					var possibleFlow = currentFlowStep + '_' + data.message;
					var responseKey = ''
					if (chatflowConfig[possibleFlow]) {
						var respVarName = chatflowConfig[currentFlowStep].responseVariable;
						if (respVarName) {
							redisSessionData[respVarName] = data.message;
						}
						currentFlowStep = possibleFlow;
						responseKey = chatflowConfig[currentFlowStep].messageKey
						// TODO : Don't call function inside each if/else if it should be called once.
						menuIntentKnown = true
						telemetryData = createInteractionData({ currentStep: currentFlowStep, responseKey: responseKey }, data.customData, false)
					} else if (data.message === '0') {
						currentFlowStep = 'step1'
						responseKey = chatflowConfig[currentFlowStep].messageKey
						menuIntentKnown = true
						// TODO : Don't call function inside each if/else if it should be called once.
						telemetryData = createInteractionData({ currentStep: currentFlowStep, responseKey: responseKey }, data.customData, false)
					} else if (data.message === '99') {
						if (currentFlowStep.lastIndexOf("_") > 0) {
							currentFlowStep = currentFlowStep.substring(0, currentFlowStep.lastIndexOf("_"))
							responseKey = chatflowConfig[currentFlowStep].messageKey
							menuIntentKnown = true
							// TODO : Don't call function inside each if/else if it should be called once. 
							telemetryData = createInteractionData({ currentStep: currentFlowStep, responseKey: responseKey }, data.customData, false)
						}
					} else {
						responseKey = getErrorMessageForInvalidInput(currentFlowStep, chatflowConfig)
						menuIntentKnown = false
						// TODO : Don't call function inside each if/else if it should be called once.
						telemetryData = createInteractionData({ currentStep: currentFlowStep + '_UNKNOWN_OPTION' }, data.customData, false)
					}
					redisSessionData['currentFlowStep'] = currentFlowStep;
					consolidatedLog(data.customData.userId, data.customData.deviceId, data.message, responseKey, menuIntentKnown);
					setRedisKeyValue(data.customData.deviceId, redisSessionData);
					telemetry.logInteraction(telemetryData)
					sendChannelResponse(res, responseKey, channel, data.customData.userId);
	
}

function consolidatedLog(userId, deviceId, message, responseKey, menuIntentKnown) {
	var intent
	if (menuIntentKnown) {
		intent = "Menu_intent_detected"
	}
	else {
		responseKey = "unknown_option"
		intent = "Menu_intent_not_detected"
	}
	LOG.info("UserId: " + userId + "," + " DeviceId: " + deviceId + "," + " UserQuery: " + message + "," + " Bot_Response_identifier: " + intent + "," + " BotResponse: " + responseKey)
}

function setRedisKeyValue(key, value) {
	const expiryInterval = 3600;
	redisClient.setex(REDIS_KEY_PREFIX + key, expiryInterval, JSON.stringify(value));
}

function delRedisKey(key) {
	redisClient.del(key);
}

function getErrorMessageForInvalidInput(currentFlowStep, chatflowConfig) {
	if (chatflowConfig[currentFlowStep + '_error']) {
		return chatflowConfig[currentFlowStep + '_error'].messageKey;
	} else {
		return chatflowConfig['step1_wrong_input'].messageKey
	}
}

//http endpoint
http.createServer(appBot).listen(config.REST_HTTP_PORT, function (err) {
	if (err) {
		throw err
	}
	LOG.info('Server started on port ' + config.REST_HTTP_PORT)
	var telemetryConfig = {
		batchSize: config.TELEMETRY_SYNC_BATCH_SIZE,
		endPoint: config.TELEMETRY_ENDPOINT,
		serviceUrl: config.TELEMETRY_SERVICE_URL,
		apiToken: config.API_AUTH_TOKEN,
		pid: config.TELEMETRY_DATA_PID,
		ver: config.TELEMETRY_DATA_VERSION
	};
	telemetry.initializeTelemetry(telemetryConfig)
});

//https endpoint only started if you have updated the config with key/crt files
if (config.HTTPS_PATH_KEY) {
	//https certificate setup
	var options = {
		key: fs.readFileSync(config.HTTPS_PATH_KEY),
		cert: fs.readFileSync(config.HTTPS_PATH_CERT),
		ca: fs.readFileSync(config.HTTPS_PATH_CA)
	};

	https.createServer(options, appBot).listen(config.REST_HTTPS_PORT, function (err) {
		if (err) {
			throw err
		}
		LOG.info('Server started on port ' + config.REST_HTTPS_PORT)
	});

}

//send data to user
function sendResponse(response, responseBody, responseCode) {
	response.set('Content-Type', 'text/plain')
	if (responseCode) response.status(responseCode)
	response.send(responseBody)
}

//send data to user
function sendResponseWhatsapp(responseBody, recipient, textContent) {
	console.log("inside sendResponseWhatsapp")
	var rsponseText = ''
	if (textContent == "freeFlow") {
		rsponseText = responseBody.data.text
	} else {
		rsponseText = responseBody
	}
	console.log("time before calling api", new Date().getTime())
	var options = {
		method: 'POST',
		url: 'https://waapi.pepipost.com/api/v2/message/',
		headers:
		{
			authorization: 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJuZXRjb3Jlc2FsZXNleHAiLCJleHAiOjI0MjUxMDI1MjZ9.ljC4Tvgz031i6DsKr2ILgCJsc9C_hxdo2Kw8iZp9tsVcCaKbIOXaFoXmpU7Yo7ob4P6fBtNtdNBQv_NSMq_Q8w',
			'content-type': 'application/json'
		},
		body:
		{
			message:
				[{
					recipient_whatsapp: recipient,
					message_type: 'text',
					recipient_type: 'individual',
					source: '461089f9-1000-4211-b182-c7f0291f3d45',
					'x-apiheader': 'custom_data',
					type_text: [{ preview_url: 'false', content: rsponseText }]
				}]
		},
		json: true
	};
	request(options, function (error, response, body) {
		if (error) throw new Error(error);

		console.log(body);
		console.log("time after calling api", new Date().getTime())
	});

}

function sendChannelResponse(response, responseKey, channel, userId, responseCode) {
	response.set('Content-Type', 'application/json')
	if (responseCode) response.status(responseCode)

	//version check
	var channelResponse = literals.message[responseKey + '_' + channel];

	if (channelResponse) {
		sendResponseWhatsapp(channelResponse, userId, "menu driven")
		response.send(channelResponse)
	} else {
		response.send(literals.message[responseKey])
	}
}

function createInteractionData(responseData, userData, isNonNumeric) {
	if (isNonNumeric) {
		return {
			interactionData: {
				id: responseData.intent ? responseData.intent : 'UNKNOWN_OPTION',
				type: responseData.intent ? responseData.intent : 'UNKNOWN_OPTION',
				subtype: responseData.intent ? 'intent_detected' : 'intent_not_detected'
			},
			requestData: userData
		}
	} else {
		return {
			interactionData: {
				id: responseData.currentStep,
				type: responseData.responseKey ? responseData.responseKey : 'UNKNOWN_OPTION',
				subtype: responseData.responseKey ? 'intent_detected' : 'intent_not_detected'
			},
			requestData: userData
		}
	}
}

/**
* This function helps to get user spec
*/
function getUserSpec(req) {
	var ua = parser(req.headers['user-agent'])
	return {
		'agent': ua['browser']['name'],
		'ver': ua['browser']['version'],
		'system': ua['os']['name'],
		'platform': ua['engine']['name'],
		'raw': ua['ua']
	}
}
