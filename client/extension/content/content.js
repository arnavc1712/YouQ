const insertChatMessage = (message) => {
    const chatbotBody = document.getElementsByClassName('chatbot-messages')[0]
    chatbotBody.insertAdjacentHTML('beforeend', `<div class="message bot-message">
                                                    <p class="message-text">
                                                        ${message}
                                                    </p>
                                                </div>`
                                )
}

const helloMessage = "Hello there! I'm YouQ, an assistant that can answer any questions you have about the YouTube video you're watching and provide more context about it. What can I help you with?"

chrome.runtime.sendMessage({ type: "tabInfo" }, tabInfo => {
    // lets open a connection to the background script
    const port = chrome.runtime.connect({name: "userMessages-"+tabInfo.tabId});
    // listen for messages from the background script
    port.onMessage.addListener((message) => {
        const chatbotBody = document.getElementsByClassName('chatbot-messages')[0]
        if (message.refresh == true) {
            // delete all children but the first one
            while (chatbotBody.children.length > 0) {
                chatbotBody.removeChild(chatbotBody.lastChild)
            }
            insertChatMessage(helloMessage)
        }

        if (message.messageStart == true) {
            chatbotBody.insertAdjacentHTML('beforeend', `<div class="message bot-message">
                                                                        <p class="message-text">
                                                                            ${message.response}
                                                                        </p>
                                                                    </div>`
                                                    )
        } else if (message.messageStart == false) {
            const botMessages = document.getElementsByClassName('bot-message')
            const lastMessage = botMessages[botMessages.length-1]
            const lastMessageText = lastMessage.querySelector('.message-text')
            lastMessageText.innerHTML = message.response
        }
    })

    fetch(chrome.runtime.getURL('/templates/content.html')).then(r => r.text()).then(html => {
        document.body.insertAdjacentHTML('beforeend', html);
        registerButtonClick()
        insertChatMessage(helloMessage)
    }).catch(e => console.error(e));
    
    
    const registerButtonClick = () => {
        const div = document.getElementsByClassName('chatbot-input')[0]
        const button = div.querySelector('button')
        button.addEventListener('click', () => {
            const input = div.querySelector('input')
            const message = input.value
            input.value = ''
            if (message.length > 0) {
                // render message
                const chatbotBody = document.getElementsByClassName('chatbot-messages')[0]
                chatbotBody.insertAdjacentHTML('beforeend', `<div class="message user-message">
                                                                <p class="message-text">
                                                                    ${message}
                                                                </p>
                                                            </div>`
                                                            )
                
                // send message to background
                port.postMessage({userMessage: message, currURL: window.location.href})
            }
        })
    }
});