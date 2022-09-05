const constants = require("../constants")
const {Parser} = require("./parser/parser")
const switcher = require("./torswitcher");

function selectExtractor(text) {
	if (text.includes("window._sharedData = ")) {
		return extractSharedData(text)
	} else if (text.includes("PolarisQueryPreloaderCache")) {
		return extractPreloader(text)
	} else if (text.includes("web_profile_info")) {
		return extractIWeb(text)
	} else {
		throw constants.symbols.extractor_results.NO_SHARED_DATA
	}
}

/**
 * @param {string} text
 * @returns {{status: symbol, value: any}}
 */
function extractSharedData(text) {
	const parser = new Parser(text)
	const index = parser.seek("window._sharedData = ", {moveToMatch: true, useEnd: true})
	if (index === -1) {
		// Maybe the profile is age restricted?
		const age = getRestrictedAge(text)
		if (age !== null) { // Correct.
			throw constants.symbols.extractor_results.AGE_RESTRICTED
		}
		throw constants.symbols.extractor_results.NO_SHARED_DATA
	}
	parser.store()
	const end = parser.seek(";</script>")
	parser.restore()
	const sharedDataString = parser.slice(end - parser.cursor)
	const sharedData = JSON.parse(sharedDataString)
	console.log(sharedData)
	// check for alternate form of age restrictions
	if (sharedData.entry_data && sharedData.entry_data.HttpGatedContentPage) {
		// ideally extracting the age should be done here, but for the web ui it doesn't matter
		throw constants.symbols.extractor_results.AGE_RESTRICTED
	}
	return sharedData.entry_data.ProfilePage[0].graphql.user
}

/**
 * @param {string} text
 * @returns {any}
 */
function extractPreloader(text) {
	const entries = []
	const parser = new Parser(text)
	while (parser.seek('{"require":[["PolarisQueryPreloaderCache"', {moveToMatch: true, useEnd: true}) !== -1) {
		if (parser.seek('{"complete":', {moveToMatch: true, useEnd: false}) !== -1) {
			let details = parser.get({split: ',"status_code":'}) + "}}"
			let data = JSON.parse(details)
			entries.push(data)
		}
	}
	// entries now has the things
	const profileInfoResponse = entries.find(x => x.request.url === "/api/v1/users/web_profile_info/")
	if (!profileInfoResponse) {
		throw new Error("No profile info in the preloader.")
	}
	return JSON.parse(profileInfoResponse.result.response).data.user
}

/**
 * @param {string} text
 * @returns {any}
 */
function extractIWeb(text) {
	const parser = new Parser(text)
	const index = parser.seek("web_profile_info\\/\",", {moveToMatch: true, useEnd: true})
	if (index === -1) {
		// Maybe the profile is age restricted?
		const age = getRestrictedAge(text)
		if (age !== null) { // Correct.
			throw constants.symbols.extractor_results.AGE_RESTRICTED
		}
		throw constants.symbols.extractor_results.NO_SHARED_DATA
	}

	// Uncomment for debugging
	//console.log("index: " + index)

	// Change this text to get the desired object that's enclosing the string
	// let enclosingObject = '"profile":{'
	let enclosingObject = '"request":{'

	parser.rewind(enclosingObject, {moveToMatch: true})
	//console.log("parser.cursor: " + parser.cursor)

	const endObjectIndex = parser.findClosingCurlyBracket()
	//console.log(endObjectIndex)

	parser.cursor += enclosingObject.length - 1
	let requestDataString = parser.slice((endObjectIndex - parser.cursor))
	//console.log(requestDataString)

	const requestData = JSON.parse(requestDataString)
	console.log(requestData)

	const queryData = requestData.params.query;

	const params = new URLSearchParams()

	Object.keys(queryData).forEach(function(k){
		params.set(k, queryData[k]);
	});

	return switcher.request("user_html", `https://i.instagram.com${requestData.url}?${params}`, async res => {
			if (res.status === 301) throw constants.symbols.ENDPOINT_OVERRIDDEN
			if (res.status === 302) throw constants.symbols.INSTAGRAM_DEMANDS_LOGIN
			if (res.status === 429) throw constants.symbols.RATE_LIMITED
			return res
		}).then(async g => {
			const res = await g.response()
			const json = await g.json()
			// require down here or have to deal with require loop. require cache will take care of it anyway.
			// User -> Timeline -> TimelineEntry -> collectors -/> User
			return json.data.user
		})
}

/**
 * @param {string} text
 */
function getRestrictedAge(text) {
	const parser = new Parser(text)
	let index = parser.seek("<h2>Restricted profile</h2>", {moveToMatch: true, useEnd: true})
	if (index === -1) return null
	index = parser.seek("<p>", {moveToMatch: true, useEnd: true})
	if (index === -1) return null
	const explanation = parser.get({split: "</p>"}).trim()
	const match = explanation.match(/You must be (\d+?) years? old or over to see this profile/)
	if (!match) return null
	return +match[1] // the age
}

module.exports.selectExtractor = selectExtractor
module.exports.extractSharedData = extractSharedData
module.exports.extractPreloader = extractPreloader
