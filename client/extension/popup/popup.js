const submitFunc = () => {
    const input = document.getElementById('api-key').value;
    if (input.length == 0) {
        alert("Please enter an API key")
    } else {
        chrome.storage.local.set({apiKey: input}, () => {
            console.log("API key saved")
        })
        // update the popup with a success message
        const div = document.getElementById('success')
        div.innerHTML = "API key saved"
    }
}

const registerButtonClick = () => {
    const button = document.getElementById('save-api-key')
    button.addEventListener('click', submitFunc)
}

const setInitials = () => {
    chrome.storage.local.get(['apiKey'], (result) => {
        if (result.apiKey!=undefined && result.apiKey!=null && result.apiKey.length > 0) {
            const input = document.getElementById('api-key')
            const div = document.getElementById('success')
            div.innerHTML = "API key already saved"
        }
    })
}

setInitials()
registerButtonClick()