const API_HOST = '<YOUR_API_HOST>';

const filter = {
    url: [
      {
        urlMatches: 'https://www.youtube.com/*',
      },
    ],
  };


const isValidJSON = str => {
  try {
    JSON.parse(str);
    return true;
  } catch (e) {
    return false;
  }
};

const getKey = async () => {
    keyResult = await chrome.storage.local.get(['apiKey'])
    if (keyResult.apiKey!=undefined && keyResult.apiKey!=null && keyResult.apiKey.length > 0) {
        return keyResult.apiKey
    } else {
        return ""
    }
}

const embedVideoTranscript = async (url) => {
    const videoId = url.split('v=')[1];
    // TODO: change this to the deployed URL
    const embedUrl = API_HOST + "/embed/" + videoId
    const openai_key = await getKey()
     
    const options = {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + openai_key
        },
        credentials: 'include',
    }
    try {
        response = await fetch(embedUrl, options)
        data = await response.json()
        if (response.ok) {
            return [data["text"], null]
        } else {
            return [null, data["error"]]
        }
    } catch(error) {
        return [null, error]
    }
}

const queryVideoTranscript = async (url, query) => {
    const videoId = url.split('v=')[1];
    const params = new URLSearchParams({query: query})
    const queryUrl = API_HOST + "/query/" + videoId + "?" + params.toString()
    const openai_key = await getKey()
    const options = {
        method: 'GET',
        headers: {
            'Authorization': 'Basic ' + openai_key
        },
        credentials: 'include',
    }
    try {
        response = await fetch(queryUrl, options)
        let reader = null;
        let error = null;

        // hack to get around the fact that the response could either be a stream or a json (im a noob)
        if (isValidJSON(response.body)) {
            obj = await response.json()
            error = obj["error"]
        } else {
            reader = response.body.getReader();
        }
        if (response.ok) {
            return [reader, null]
        } else {
            return [null, error?error:"There was an error. Please try again later"]
        }
    } catch(error) {
        return [null, error]
    }
}
    
var currentURLs = {};
var contentPorts = {};

// listening for messages from the content script
chrome.runtime.onConnect.addListener((port) => {
    if (port.name.startsWith("userMessages")) {
        contentPorts[port.name] = port;
        port.onMessage.addListener((message) => {
            if (message.userMessage!=undefined && message.userMessage!=null && message.userMessage.length > 0 && message.currURL!=undefined && message.currURL!=null && message.currURL.length > 0 && message.currURL.startsWith('https://www.youtube.com/watch?v=')) {
                queryVideoTranscript(message.currURL, message.userMessage).then(async ([reader, err]) => {
                    if (err) {
                        port.postMessage({response: "There was an error. It might either be due to the video not being transcribed or a network issue.", messageStart: true});
                    }
                    else {
                        var i = 0;
                        fullResponse = ""
                        while (true) {
                            const {done, value} = await reader.read(); 
                            if (done) break; 
                            const text = new TextDecoder().decode(value); 
                            if (i == 0) {
                                fullResponse = text
                                port.postMessage({response: fullResponse, messageStart: true});
                            } else {
                                fullResponse += text
                                port.postMessage({response: fullResponse, messageStart: false});
                            }
                            i+=1;
                        }
                    }
                })
            }
        })

        port.onDisconnect.addListener((port) => {
            delete contentPorts[port.name]
            tabId = port.name.split("-")[1]
            delete currentURLs[tabId]
        })
    }
})

const onPageLoad = async (url) => {
    let [response, err] = await embedVideoTranscript(url)
    if (err) {
        console.log(err)
    } else {
        console.log(response)
    }
}

chrome.webNavigation.onCompleted.addListener(async (details) => {
    var url = details.url;
    if (url!=undefined && url.startsWith('https://www.youtube.com')) {
        let currentURL = currentURLs[details.tabId]
        if (currentURL != url || currentURL == null) {
            currentURLs[details.tabId] = url;
            let port = contentPorts["userMessages-"+details.tabId]
            if (port!=null) {
                port.postMessage({refresh: true})
            }
        }     
    }   
    if (url.startsWith('https://www.youtube.com/watch?v=')) {
       await onPageLoad(url)
    }
}, filter);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url!=undefined && changeInfo.url.startsWith('https://www.youtube.com')) {
        let currentURL = currentURLs[tabId]
        if (currentURL != changeInfo.url || currentURL == null) {
            currentURLs[tabId] = changeInfo.url;
            let port = contentPorts["userMessages-"+tabId]
            if (port!=null) {
                port.postMessage({refresh: true})
            }
        }        
    }
    // check for a URL in the changeInfo parameter (url is only added when it is changed)
    if (changeInfo.url!=undefined && changeInfo.url.startsWith('https://www.youtube.com/watch?v=')) {
        await onPageLoad(changeInfo.url)
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type == "tabInfo") {
        sendResponse({tabId: sender.tab.id})
    } else {
        sendResponse({})
    }
    return true
})
// adding message listener
// chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
//     if (request.userMessage!=undefined && request.userMessage!=null && request.userMessage.length > 0 && request.currURL!=undefined && request.currURL!=null && request.currURL.length > 0) {
//         queryVideoTranscript(request.currURL, request.userMessage).then(async ([reader, err]) => {
//             console.log(reader)
//             if (err) {
//                 console.log(err)
//                 sendResponse({response: "There was an error. Please try again later", messageStart: true});
//             }
//             else {
//                 let i = 0;
//                 fullResponse = ""
//                 while (true) {
//                     const {done, value} = await reader.read(); 
//                     if (done) break; 
//                     const text = new TextDecoder().decode(value); 
//                     console.log(done, value, text)
//                     if (i == 0) {
//                         fullResponse = text
//                         sendResponse({response: fullResponse, messageStart: true});
//                     } else {
//                         fullResponse += text
//                         sendResponse({response: fullResponse, messageStart: false});
//                     }
//                     i+=1;
//                 }
//             }
//         })
//         }
//         return true;
//     }
// );
