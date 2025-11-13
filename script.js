// --- CONSTANTS ---
const OLLAMA_SERVER_URL = "http://127.0.0.1:5000"; // Flask proxy
const OLLAMA_PROXY_URL = OLLAMA_SERVER_URL; // Alias for clarity in suggestTitle
const CHAT_MESSAGES = document.getElementById('chat-messages');
const PROMPT_INPUT = document.getElementById('prompt-input');
const SEND_BUTTON = document.getElementById('send-button');
const MODEL_SELECTOR = document.getElementById('model-selector');
const CURRENT_MODEL_NAME = document.getElementById('current-model-name');
const CONVERSATION_LIST = document.getElementById('conversation-list');
const WELCOME_SCREEN_HTML = document.getElementById('welcome-screen')?.outerHTML || '';

// Model Info
const MODEL_INFO_TEXT = document.getElementById('model-description-text');

// System Prompt Modal Constants (Must be present for this logic)
const SYSTEM_PROMPT_MODAL = document.getElementById('system-prompt-modal');
const MODAL_SYSTEM_PROMPT_INPUT = document.getElementById('modal-system-prompt-input');
const SAVE_SYSTEM_PROMPT_BTN = document.getElementById('save-system-prompt-btn');
const CLEAR_SYSTEM_PROMPT_BTN = document.getElementById('clear-system-prompt-btn');
const CLOSE_SYSTEM_PROMPT_MODAL_BTN = document.getElementById('close-system-prompt-modal-btn');
const EDIT_PERSONA_BTN = document.getElementById('edit-persona-btn');


// --- GLOBAL STATE ---
let db; // IndexedDB database instance
let selectedModel = '';
let messages = []; // Messages for the *currently active* chat
let isSending = false;
let currentChatId = null;
let currentSystemPrompt = ''; // STATE: The system persona for the current chat
const MODEL_DESCRIPTION_CACHE = {}; // Cache for generated descriptions (Self-description is cached)

// Attachment state is now temporary, only for the in-progress message
let attachedImageBase64 = null; // Holds the Base64 data (data part only)
let attachedImageHTML = null; // Holds the <img> tag (full data URL)

// --- UTILS ---

/**
 * Updates the appearance of the 'Edit Persona' button based on whether a system prompt is active.
 */
function updatePersonaButtonState() {
    if (!EDIT_PERSONA_BTN) return;

    if (currentSystemPrompt.trim()) {
        // Active state
        EDIT_PERSONA_BTN.classList.remove('text-indigo-400');
        EDIT_PERSONA_BTN.classList.add('text-green-400', 'bg-gray-700/50');
        EDIT_PERSONA_BTN.title = 'Persona is active! Click to edit.';
    } else {
        // Inactive state
        EDIT_PERSONA_BTN.classList.add('text-indigo-400');
        EDIT_PERSONA_BTN.classList.remove('text-green-400', 'bg-gray-700/50');
        EDIT_PERSONA_BTN.title = 'Set a System Persona for this chat.';
    }
}

/**
 * Updates the display of the System Prompt at the top of the chat window.
 */
function updateSystemPromptDisplay() {
    const existingPromptDisplay = document.getElementById('system-prompt-display');
    
    if (currentSystemPrompt.trim()) {
        const displayHTML = `
            <div id="system-prompt-display" class="w-full max-w-3xl mx-auto py-2">
                <div class="px-4 py-3 rounded-xl text-sm border border-indigo-500/50 bg-indigo-900/30 text-indigo-300">
                    <strong class="font-semibold">Persona Active:</strong> ${currentSystemPrompt.trim()}
                </div>
            </div>
        `;
        
        if (existingPromptDisplay) {
            // Update in place if it exists
            existingPromptDisplay.innerHTML = displayHTML;
        } else if (CHAT_MESSAGES.firstChild) {
            // Insert at the top if the chat is not empty
            CHAT_MESSAGES.insertAdjacentHTML('afterbegin', displayHTML);
        }
    } else if (existingPromptDisplay) {
        // Remove if it exists and the prompt is empty
        existingPromptDisplay.remove();
    }
}


/**
 * Copies the given text to the clipboard using modern API (preferred method)
 * with a fallback using the deprecated document.execCommand('copy').
 * @param {string} text The text content to copy.
 */
function copyToClipboard(text) {
    // 1. Try the modern Clipboard API
    if (navigator.clipboard) {
        return navigator.clipboard.writeText(text)
            .then(() => Promise.resolve()) 
            .catch(err => {
                console.error("Failed to copy using navigator.clipboard: ", err);
                return fallbackCopy(text);
            });
    }
    
    // 2. Directly use fallback
    return fallbackCopy(text);
}

/**
 * Fallback mechanism using document.execCommand('copy').
 * @param {string} text The text content to copy.
 */
function fallbackCopy(text) {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '0';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        
        textarea.focus();
        textarea.select();
        
        document.execCommand('copy');
        document.body.removeChild(textarea);

        return Promise.resolve(); 
    } catch (err) {
        console.error('Fallback copy failed:', err);
        return Promise.reject(new Error('Copying failed in fallback.'));
    }
}

/**
 * Renders Markdown content, including syntax highlighting and adding copy buttons
 * to code blocks.
 * @param {string} markdownText - The Markdown text to process.
 * @returns {string} - The final HTML content.
 */
function renderMarkdown(markdownText) {
    // 1. Parse Markdown to HTML
    const html = marked.parse(markdownText);
    const container = document.createElement('div');
    container.innerHTML = html;

    // 2. Find all code blocks (pre code)
    container.querySelectorAll('pre code').forEach(block => {
        // Apply syntax highlighting
        hljs.highlightElement(block);

        // Get the parent <pre> element
        const pre = block.closest('pre');

        // Create a wrapper div to contain the code and the button, and set position: relative
        const wrapper = document.createElement('div');
        wrapper.className = 'code-container';
        
        // Replace the <pre> with the new wrapper
        pre.parentNode.replaceChild(wrapper, pre);
        wrapper.appendChild(pre);

        // Create the copy button
        const copyButton = document.createElement('button');
        copyButton.className = 'copy-button';
        copyButton.textContent = 'Copy';
        
        // Insert the button into the wrapper
        wrapper.appendChild(copyButton);

        // Add the copy logic
        copyButton.addEventListener('click', () => {
            const codeContent = block.textContent;
            
            copyToClipboard(codeContent).then(() => {
                copyButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyButton.textContent = 'Copy';
                }, 2000); 
            }).catch(err => {
                console.error('Failed to copy code, even with fallback:', err);
                copyButton.textContent = 'Error!';
                setTimeout(() => {
                    copyButton.textContent = 'Copy';
                }, 2000);
            });
        });
    });

    return container.innerHTML;
}

/**
 * Automatically adjusts the height of the textarea and updates the send button state.
 * @param {HTMLTextAreaElement} field 
 */
function autoExpand(field) {
    field.style.height = 'auto';
    field.style.height = field.scrollHeight + 'px';
    // Use the comprehensive check for enabling the send button
    checkInputAndToggleSendButton(); 
}

/**
 * Checks if the prompt input or an image attachment exists and toggles the send button.
 */
function checkInputAndToggleSendButton() {
    const hasText = PROMPT_INPUT.value.trim().length > 0;
    const hasImage = attachedImageBase64 !== null;
    SEND_BUTTON.disabled = isSending || (!hasText && !hasImage);
}

// --- INDEXEDDB DATABASE FUNCTIONS ---

/**
 * Opens and initializes the IndexedDB database.
 * NOTE: Version 3 is used to ensure compatibility with systemPrompt saving.
 */
async function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('QuantelChatDB', 3);

        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target.error);
            reject("IndexedDB error");
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            resolve();
        };

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains('chats')) {
                // KeyPath is 'id', which remains the same
                db.createObjectStore('chats', { keyPath: 'id' });
            }
            // The store implicitly supports new fields like 'systemPrompt'
        };
    });
}

/**
 * Saves (creates or updates) a complete chat object in the DB.
 * Ensures systemPrompt is always included.
 */
async function saveChat(chatObject) {
    return new Promise((resolve, reject) => {
        if (!db) return reject("DB not initialized");
        const transaction = db.transaction(['chats'], 'readwrite');
        const store = transaction.objectStore('chats');
        
        // Ensure systemPrompt is saved with the chat object
        const chatToSave = { 
            ...chatObject, 
            systemPrompt: currentSystemPrompt, // <-- Inject current system prompt
            timestamp: Date.now(), // Ensure timestamp is up-to-date
        };

        const request = store.put(chatToSave);

        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
    });
}

/** Retrieves a single, complete chat object by its ID. */
async function getChat(chatId) {
    return new Promise((resolve, reject) => {
        if (!db) return resolve(null);
        const transaction = db.transaction(['chats'], 'readonly');
        const store = transaction.objectStore('chats');
        const request = store.get(chatId);

        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

/** Retrieves metadata (id, title, timestamp) for all chats, newest first. */
async function getAllChatsMetadata() {
    return new Promise((resolve, reject) => {
        if (!db) return resolve([]);
        const transaction = db.transaction(['chats'], 'readonly');
        const store = transaction.objectStore('chats');
        const metadata = [];
        
        // Use 'prev' to iterate in descending order (newest first)
        const request = store.openCursor(null, 'prev'); 

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                // Only return the necessary metadata
                metadata.push({
                    id: cursor.value.id,
                    title: cursor.value.title || 'Untitled Chat',
                    timestamp: cursor.value.timestamp
                });
                cursor.continue();
            } else {
                resolve(metadata);
            }
        };
        request.onerror = (event) => reject(event.target.error);
    });
}

/** Deletes a chat from the DB by its ID. */
async function deleteChatDB(chatId) {
    return new Promise((resolve, reject) => {
        if (!db) return reject("DB not initialized");
        const transaction = db.transaction(['chats'], 'readwrite');
        const store = transaction.objectStore('chats');
        const request = store.delete(chatId);

        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
    });
}

// --- CHAT AND UI FUNCTIONS ---

/**
 * Saves the current chat messages and metadata to IndexedDB.
 * @param {string | null} suggestedTitle - The suggested title if it's the first save.
 */
async function saveCurrentMessages(suggestedTitle = null) {
    if (!currentChatId || !db) return;

    let title;

    if (suggestedTitle) {
        title = suggestedTitle;
    } else {
        const chat = await getChat(currentChatId);
        if (chat) {
            title = chat.title;
        } else {
            const firstUserMsg = messages.find(m => m.role === 'user');
            title = firstUserMsg ? firstUserMsg.content.substring(0, 30) + (firstUserMsg.content.length > 30 ? '...' : '') : 'New Chat';
        }
    }
    
    // Ensure attachmentHTML is only kept for display if it exists on the message object, 
    // but the DB save should not rely on the temporary global variable.
    const serializableMessages = messages.map(msg => {
        // Strip temporary frontend-only keys like 'attachmentHTML' and 'error' before saving
        const { attachmentHTML, error, ...rest } = msg;
        return rest;
    });

    const chatObject = {
        id: currentChatId,
        title: title,
        messages: serializableMessages,
    };

    await saveChat(chatObject);
    await renderConversationList(); // Refresh sidebar
}

/**
 * Loads a chat by ID, restoring state and rendering messages.
 * @param {string} chatId 
 */
async function loadChat(chatId) {
    const chatToLoad = await getChat(chatId);
    if (!chatToLoad) return;
    
    currentChatId = chatToLoad.id;
    selectedModel = chatToLoad.model || selectedModel; // Retain model if saved, otherwise keep current
    
    // RESTORE SYSTEM PROMPT STATE
    currentSystemPrompt = chatToLoad.systemPrompt || ''; 
    updatePersonaButtonState();
    
    // RESTORE MESSAGES: Re-add attachmentHTML for display purposes
    messages = chatToLoad.messages.map(msg => ({
        ...msg,
        attachmentHTML: msg.images && msg.images.length > 0 
            ? `<img src="data:image/jpeg;base64,${msg.images[0]}" alt="Attached Image" class="max-w-full max-h-48 rounded-lg mb-2 object-contain shadow-md border border-gray-700">`
            : null
    }));
    
    // Update UI
    CHAT_MESSAGES.innerHTML = '';
    
    // The first renderMessage will handle the System Prompt display
    messages.forEach((msg, index) => {
        const messageId = `msg-${chatId}-${index}`; 
        renderMessage(msg.role, msg.content, false, messageId, msg.attachmentHTML);
    });

    removeAttachment(); // Clear any existing attachment in the input area
    updateSystemPromptDisplay(); // Ensure it's rendered at the top
    
    // Scroll to bottom
    CHAT_MESSAGES.scrollTo({ top: CHAT_MESSAGES.scrollHeight, behavior: 'auto' });
    
    // Update sidebar highlight
    await renderConversationList();
}

/**
 * Renders a single message block in the chat.
 */
function renderMessage(role, content, isStreaming = false, id = null, attachmentHTML = null) {
    const welcomeScreen = document.getElementById('welcome-screen');
    if (welcomeScreen) welcomeScreen.remove();

    // The first message rendered should ensure the System Prompt is visible
    if (!document.getElementById('system-prompt-display')) {
        updateSystemPromptDisplay();
    }
    
    const roleClass = role === 'user' ? 'bg-[#343541]' : 'bg-[#444654]';
    const icon = role === 'user' ? 
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-6 h-6 text-gray-300"><path fill-rule="evenodd" d="M7.5 6a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0ZM3.751 20.105a8.25 8.25 0 0 1 16.498 0 .75.75 0 0 1-.437.695A18.683 18.683 0 0 1 12 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 0 1-.437-.695Z" clip-rule="evenodd" /></svg>` : 
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-6 h-6 text-indigo-400"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25Zm-3.09 8.655a.75.75 0 0 0 .919.497 44.373 44.373 0 0 1 5.923 1.258.75.75 0 0 0 .919-.497 12.04 12.04 0 0 0 1.258-5.923.75.75 0 0 0-.497-.919 44.373 44.373 0 0 1-5.923-1.258.75.75 0 0 0-.919.497 12.04 12.04 0 0 0-1.258 5.923Z" clip-rule="evenodd" /></svg>`;

    // When loading from a saved chat (not streaming), we must strip any <think> blocks
    const contentToRender = isStreaming ? content : content.replace(/<think>(.*?)<\/think>/gs, '');
    
    const existingElement = id ? document.getElementById(id) : null;
    let messageElement;

    if (existingElement) {
        messageElement = existingElement;
        const contentDiv = messageElement.querySelector('.message-content');
        
        // Update content if streaming or if content has changed (for non-streaming final render)
        if (contentDiv) {
            contentDiv.innerHTML = renderMarkdown(contentToRender + (isStreaming ? '▌' : ''));
        }
    } else {
        messageElement = document.createElement('div');
        messageElement.className = `message-box w-full ${roleClass} flex justify-center py-6`;
        if (id) messageElement.id = id;

        messageElement.innerHTML = `
            <div class="flex max-w-3xl w-full px-4">
                <div class="flex-shrink-0 w-8 mr-4 mt-1">${icon}</div>
                <div class="flex-grow min-w-0">
                    ${attachmentHTML || ''} 
                    <div class="message-content text-base leading-relaxed markdown-content">
                        ${renderMarkdown(contentToRender + (isStreaming ? '▌' : ''))}
                    </div>
                </div>
            </div>
        `;
        CHAT_MESSAGES.appendChild(messageElement);
    }
    
    CHAT_MESSAGES.scrollTo({
        top: CHAT_MESSAGES.scrollHeight,
        behavior: 'smooth' 
    });
}

/**
 * Updates the conversation list in the sidebar.
 */
async function renderConversationList() {
    const allChats = await getAllChatsMetadata(); 
    
    CONVERSATION_LIST.innerHTML = '';

    if (allChats.length === 0) {
        CONVERSATION_LIST.innerHTML = '<p class="text-xs text-gray-500 p-2">No conversations yet.</p>';
        return;
    }

    allChats.forEach(chat => {
        const date = new Date(chat.timestamp).toLocaleDateString();
        
        const isActive = chat.id === currentChatId;
        const activeClass = isActive ? 'bg-indigo-700/50' : 'hover:bg-gray-700/50';

        const item = document.createElement('div');
        item.id = `convo-container-${chat.id}`;
        item.className = `conversation-link group block text-sm p-2 rounded-lg transition duration-150 ${activeClass} mb-1 cursor-pointer`;
        // Use an anonymous function to prevent unnecessary global exposure and to stop event propagation on buttons
        item.onclick = () => loadChat(chat.id); 

        item.innerHTML = `
            <div class="flex items-center justify-between">
                <div class="flex-grow min-w-0 pr-2 overflow-hidden" title="${chat.title}">
                    <span id="title-${chat.id}" class="font-medium truncate block">${chat.title}</span>
                    <span class="block text-xs text-gray-400 mt-0.5">${date}</span>
                </div>
                <div class="flex space-x-1 flex-shrink-0 transition-opacity 
                            ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}">
                    <button onclick="event.stopPropagation(); renameConversation('${chat.id}')"
                            class="p-1 rounded-md text-gray-400 hover:text-white hover:bg-gray-600 transition"
                            title="Rename Conversation">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                        </svg>
                    </button>
                    <button onclick="event.stopPropagation(); deleteConversation('${chat.id}')"
                            class="p-1 rounded-md text-red-400 hover:text-white hover:bg-red-700 transition"
                            title="Delete Conversation">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
        CONVERSATION_LIST.appendChild(item);
    });
}

/**
 * Deletes a chat by ID.
 * @param {string} chatId 
 */
async function deleteConversation(chatId){
    const isCurrent = chatId == currentChatId;
    if (!chatId) return;
    try {
        await deleteChatDB(chatId);
        const allChats = await getAllChatsMetadata();
        
        if (isCurrent) {
            if (allChats.length > 0) {
                // Load the next most recent chat
                await loadChat(allChats[0].id);
            } else {
                // Start a new chat if none are left
                newChat();
            }
        }
        await renderConversationList();
    } catch(e) {
        console.error("Failed to delete chat:", e);
    }
}

/**
 * Prompts the user to rename a conversation.
 * @param {string} chatId 
 */
async function renameConversation(chatId){
    if (!chatId) return;
    
    const chatToRename = await getChat(chatId);
    if (!chatToRename) return;

    const newTitle = window.prompt("Enter new title for this conversation:", chatToRename.title);
    
    if (newTitle && newTitle.trim().length > 0) {
        chatToRename.title = newTitle.trim();
        // Saving calls saveChat which updates timestamp and systemPrompt
        await saveChat(chatToRename); 
        
        await renderConversationList(); 
    }
}

// --- Think Block Logic ---

/**
 * Extracts content within <think> tags, displays it, and returns the stripped content.
 * @param {string} chunk - The current chunk of model response content.
 * @param {string} messageId - The ID of the assistant's message element.
 * @returns {{strippedContent: string, thinkingText: string}}
 */
function processThinking(chunk, messageId) {
    // Regex to find and remove <think>...</think> blocks globally
    const THINK_REGEX = /<think>(.*?)<\/think>/gs;
    let thinkingText = '';
    
    // Replace the whole <think> block with nothing in the final output and capture content
    const strippedContent = chunk.replace(THINK_REGEX, (match, p1) => {
        thinkingText += p1;
        return ''; 
    });

    return { strippedContent, thinkingText };
}

/**
 * Creates or updates the temporary thinking display area for a given message.
 * @param {string} messageId - The ID of the assistant's message element.
 * @param {string} thinkingText - The new thinking text chunk to append.
 */
function updateThinkingDisplay(messageId, thinkingText) {
    const element = document.getElementById(messageId);
    if (!element) return;

    let thinkingContainer = element.querySelector('.thinking-container');
    
    // Find the main content wrapper (the flex-grow div)
    const contentWrapper = element.querySelector('.flex-grow');
    if (!contentWrapper) return;

    if (!thinkingContainer) {
        thinkingContainer = document.createElement('div');
        thinkingContainer.className = 'thinking-container mb-3 p-3 bg-gray-600/50 rounded-xl shadow-inner border border-gray-700 text-sm text-gray-300 transition-all duration-300';
        thinkingContainer.innerHTML = '<strong class="text-indigo-400">Thinking Process:</strong> <span class="thinking-text"></span>';
        
        // Insert it before the main message content
        const mainContent = element.querySelector('.message-content');
        contentWrapper.insertBefore(thinkingContainer, mainContent);
    }
    
    const thinkingTextEl = thinkingContainer.querySelector('.thinking-text');
    if (thinkingTextEl) {
        thinkingTextEl.textContent += thinkingText;
    }
    
    // Auto-scroll after updating thinking text
    CHAT_MESSAGES.scrollTo({ top: CHAT_MESSAGES.scrollHeight, behavior: 'auto' });
}

/**
 * Hides the thinking display area when the response is complete.
 * @param {string} messageId - The ID of the assistant's message element.
 */
function hideThinkingDisplay(messageId) {
    const element = document.getElementById(messageId);
    const thinkingContainer = element ? element.querySelector('.thinking-container') : null;
    if (thinkingContainer) {
        // Set height to 0 and opacity to 0 for a smooth disappearance before removing
        thinkingContainer.style.opacity = '0';
        thinkingContainer.style.height = '0';
        setTimeout(() => {
            thinkingContainer.remove();
        }, 300); // Match transition duration
    }
}

// --- Core Chat Functions ---

/**
 * Starts a new conversation, clears UI, and resets state.
 */
function newChat() {
    currentChatId = crypto.randomUUID();
    messages = [];
    currentSystemPrompt = ''; // Reset system prompt
    attachedImageBase64 = null;
    attachedImageHTML = null;
    PROMPT_INPUT.value = '';
    PROMPT_INPUT.style.height = 'auto';
    
    // Clear attachment UI (using the IDs from the complete HTML)
    document.getElementById('image-upload').value = null;
    document.getElementById('image-preview-container')?.classList.add('hidden');
    
    // Update UI state
    CHAT_MESSAGES.innerHTML = WELCOME_SCREEN_HTML;
    updatePersonaButtonState(); // Update persona button to inactive
    updateSystemPromptDisplay(); // Remove display
    updateConversationList(); 
    checkInputAndToggleSendButton();
}


/**
 * Sends the message to the Ollama proxy.
 */
async function sendMessage() {
    if (isSending || (!PROMPT_INPUT.value.trim() && !attachedImageBase64) || !selectedModel) return;

    const userPrompt = PROMPT_INPUT.value.trim();
    isSending = true;
    PROMPT_INPUT.disabled = true;
    SEND_BUTTON.disabled = true;

    // 1. Construct the user message object
    const userMessage = { role: 'user', content: userPrompt };
    const firstMessage = messages.length === 0;

    if (attachedImageBase64) {
        userMessage.images = [attachedImageBase64]; 
        userMessage.attachmentHTML = attachedImageHTML;
    }

    // Add user message to local state and render
    messages.push(userMessage);
    renderMessage('user', userPrompt, false, undefined, attachedImageHTML); 

    // Clear input area
    PROMPT_INPUT.value = '';
    autoExpand(PROMPT_INPUT);

    const assistantId = `msg-${Date.now()}`;
    let assistantContent = '';
    // Add placeholder message for the streaming response
    messages.push({ role: 'assistant', content: '', isPlaceholder: true });
    renderMessage('assistant', 'Thinking...', true, assistantId);

    // 2. Prepare the full message history array for the API
    let messagePayload = messages
        .filter(msg => !msg.isPlaceholder) // Remove the placeholder
        .map(msg => {
            // Strip temporary frontend-only keys before sending
            const { attachmentHTML, error, ...rest } = msg;
            return rest;
        });
    
    // Inject System Prompt if it exists
    if (currentSystemPrompt.trim()) {
        messagePayload.unshift({
            role: 'system',
            content: currentSystemPrompt.trim()
        });
    }


    try {
        const response = await fetch(`${OLLAMA_SERVER_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: selectedModel, messages: messagePayload })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const json = JSON.parse(line);
                    if (json.message?.content) {
                        
                        // Process the chunk to extract thinking content
                        const { strippedContent, thinkingText } = processThinking(json.message.content, assistantId);
                        
                        if (thinkingText) {
                            updateThinkingDisplay(assistantId, thinkingText);
                        }

                        assistantContent += strippedContent;
                        renderMessage('assistant', assistantContent, true, assistantId);
                    }
                } catch (e) {
                    // console.warn('Failed to parse chunk:', line);
                }
            }
        }

        // 3. Finalize assistant message and save
        // Remove placeholder and add the final, complete message
        messages.pop(); 
        messages.push({ role: 'assistant', content: assistantContent });
        renderMessage('assistant', assistantContent, false, assistantId);
        
        // 4. Save chat history and suggest title if first message
        if (firstMessage) { 
            await saveCurrentMessages(); 
            suggestTitle(currentChatId, selectedModel, userPrompt); 
        } else {
            await saveCurrentMessages(); 
        }

    } catch (error) {
        console.error('Error:', error);
        const errorMsg = `**Error:** ${error.message}`;
        // Remove the placeholder message before adding the error message
        if (messages.slice(-1)[0]?.isPlaceholder) messages.pop();
        messages.push({ role: 'assistant', content: errorMsg, error: true });

        renderMessage('assistant', errorMsg, false, assistantId);
        await saveCurrentMessages(); // Save error message too
    } finally {
        removeAttachment(); 
        isSending = false;
        PROMPT_INPUT.disabled = false;
        checkInputAndToggleSendButton();
        PROMPT_INPUT.focus();
        
        // Hide the thinking area when streaming is finished (or failed)
        hideThinkingDisplay(assistantId);
    }
}

// --- Image Attachment and Compression Logic ---

/**
 * Compresses an image data URL (PNG, JPEG) to a high-quality JPEG Data URL.
 * @param {string} originalDataURL - The original data URL of the image.
 * @param {number} quality - JPEG quality (0.0 to 1.0). Default is 0.8 (80%).
 * @param {number} maxSize - Max width/height to resize to. Default is 1200px.
 * @returns {Promise<string>} - The compressed JPEG Data URL.
 */
function compressImageToJPEG(originalDataURL, quality = 0.8, maxSize = 1200) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Simple resizing logic
                if (width > height) {
                    if (width > maxSize) {
                        height *= maxSize / width;
                        width = maxSize;
                    }
                } else {
                    if (height > maxSize) {
                        width *= maxSize / height;
                        height = maxSize;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                
                ctx.drawImage(img, 0, 0, width, height);
                
                const compressedDataURL = canvas.toDataURL('image/jpeg', quality);
                canvas.remove();
                
                resolve(compressedDataURL);
            } catch (e) {
                reject(new Error("Image compression failed."));
            }
        };
        img.onerror = () => reject(new Error("Failed to load image for compression."));
        img.src = originalDataURL;
    });
}

/**
 * Handles the file input change for image attachments.
 * Renamed to match the HTML `onchange` call for simplicity.
 * @param {Event} event - The file input change event.
 */
async function handleFileSelect(event) {
    const file = event.target.files[0];
    const previewContainer = document.getElementById('image-preview-container');
    const previewImg = document.getElementById('image-preview')?.querySelector('img');
    const attachmentFileName = document.getElementById('attachment-file-name'); // Assuming this element exists near the input for feedback

    // Reset previous attachment state and UI
    attachedImageBase64 = null;
    attachedImageHTML = null;
    if (previewContainer) {
        previewContainer.classList.add('hidden');
    }
    if (attachmentFileName) {
        attachmentFileName.textContent = '';
    }
    
    // Clear the input value so the same file can be re-uploaded/re-processed
    event.target.value = null;

    if (!file) return;

    if (!file.type.startsWith('image/')) {
        alert("Only image files are supported for attachment.");
        return;
    }

    if (file.size > 20 * 1024 * 1024) { 
        alert('File is too large (> 20MB). Please select a smaller image.');
        return;
    }
    
    // Show a loading indicator
    if (attachmentFileName) {
        attachmentFileName.textContent = `Compressing ${file.name}...`;
    }

    const reader = new FileReader();
    reader.onload = async function(e) {
        const originalDataURL = e.target.result;
        
        try {
            // STEP 1: COMPRESS the image to JPEG (80% quality) and potentially resize to 1200px max
            const compressedDataURL = await compressImageToJPEG(originalDataURL, 0.8, 1200);
            
            // STEP 2: Update state with compressed data
            attachedImageHTML = `<img src="${compressedDataURL}" alt="Attached Image" class="max-w-full max-h-48 rounded-lg mb-2 object-contain shadow-md border border-gray-700">`;
            attachedImageBase64 = compressedDataURL.split(',')[1];
            
            // STEP 3: Update UI
            if (previewImg && previewContainer) {
                previewImg.src = compressedDataURL;
                previewContainer.classList.remove('hidden');
            }
            
            // Display file info and compression result
            if (attachmentFileName) {
                const originalSizeKB = (file.size / 1024).toFixed(2);
                const compressedBinarySize = attachedImageBase64.length * 0.75;
                const compressedSizeKB = (compressedBinarySize / 1024).toFixed(2);
                attachmentFileName.textContent = `${file.name} (Orig: ${originalSizeKB} KB / Sent: ${compressedSizeKB} KB JPG)`;
            }

            checkInputAndToggleSendButton();

        } catch (error) {
            console.error(error);
            alert('Error during image processing. Try a different image or smaller file.');
            if (attachmentFileName) attachmentFileName.textContent = 'Error processing file.';
        }
    };
    reader.readAsDataURL(file);
}

/**
 * Removes the currently attached image.
 */
function removeAttachment() {
    attachedImageBase64 = null;
    attachedImageHTML = null;
    document.getElementById('image-upload').value = null;
    document.getElementById('image-preview-container')?.classList.add('hidden');
    if (document.getElementById('attachment-file-name')) {
        document.getElementById('attachment-file-name').textContent = '';
    }
    
    autoExpand(PROMPT_INPUT);
}

// --- Model and Title Logic ---
/**
 * Fetches the list of available models from the Ollama proxy.
 */
async function fetchModels() {
    MODEL_SELECTOR.innerHTML = `<option>Loading models...</option>`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

        const response = await fetch(`${OLLAMA_PROXY_URL}/api/tags`, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
            const data = await response.json();
            let models = data.models || []; // Use 'let' to allow reassignment

            // Filter out embedding and reranker models
            models = models.filter(model => {
                const name = model.name.toLowerCase();
                // Check for common embedding/vector/reranker keywords in the model name
                return !name.includes('embed') && 
                       !name.includes('vector') &&
                       !name.includes('reranker');
            });
            
            // Handle case where all models were filtered out
            if (models.length === 0) {
                MODEL_SELECTOR.innerHTML = `<option>No chat models found</option>`;
                CURRENT_MODEL_NAME.textContent = 'None';
                if (MODEL_INFO_TEXT) MODEL_INFO_TEXT.textContent = 'Please pull a general-purpose model (e.g., Llama 3) via Ollama.';
                return;
            }

            MODEL_SELECTOR.innerHTML = '';
            
            // Sort models alphabetically
            models.sort((a, b) => a.name.localeCompare(b.name));
            
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.name;
                option.textContent = model.name.replace(':latest', ''); // Display clean name
                MODEL_SELECTOR.appendChild(option);
            });

            // Automatically select the first model or the previously loaded one
            selectedModel = selectedModel || models[0].name;
            MODEL_SELECTOR.value = selectedModel;
            CURRENT_MODEL_NAME.textContent = MODEL_SELECTOR.options[MODEL_SELECTOR.selectedIndex].textContent;
            
            // Fetch description for the initially selected model
            updateModelInfo(selectedModel);

        } else {
            MODEL_SELECTOR.innerHTML = `<option>Error fetching models</option>`;
            CURRENT_MODEL_NAME.textContent = 'ERROR';
            if (MODEL_INFO_TEXT) MODEL_INFO_TEXT.textContent = 'Cannot fetch model list.';
        }
    } catch (err) {
        console.error('Model fetch error:', err);
        let msg = 'Failed to load models';
        if (err.name === 'AbortError') msg = 'Timed out (5s)';
        else if (err.message.includes('Failed to fetch')) msg = 'Proxy not running';
        MODEL_SELECTOR.innerHTML = `<option>${msg}</option>`;
        CURRENT_MODEL_NAME.textContent = 'ERROR';
        if (MODEL_INFO_TEXT) MODEL_INFO_TEXT.textContent = `Error: ${msg}.`;
    }
}

/**
 * Fetches or generates a description for the selected model.
 * @param {string} modelName 
 */
async function updateModelInfo(modelName) {
    if (!modelName || !MODEL_INFO_TEXT) return;

    if (MODEL_DESCRIPTION_CACHE[modelName]) {
        MODEL_INFO_TEXT.textContent = MODEL_DESCRIPTION_CACHE[modelName];
        return;
    }

    const nameForDisplay = modelName.split('/').pop().split(':')[0];
    MODEL_INFO_TEXT.textContent = `Generating description...`;
    
    try {
        const SELF_DESCRIBING_MODEL = modelName;

        const response = await fetch(`${OLLAMA_SERVER_URL}/api/describe_model`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                generator_model: SELF_DESCRIBING_MODEL, // The model asks itself
                target_model_name: modelName 
            }),
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();
        const description = data.description || 'Could not retrieve dynamic model description. The model might be too small or slow to describe itself.';

        MODEL_DESCRIPTION_CACHE[modelName] = description;
        MODEL_INFO_TEXT.textContent = description;

    } catch (error) {
        console.error('Error describing model:', error);
        MODEL_INFO_TEXT.textContent = `Error: Failed to get description from ${nameForDisplay}. Check if the Flask proxy has the /api/describe_model endpoint.`;
    }
}

/**
 * Suggests a title for the current conversation based on the first message.
 * @param {string} chatId 
 * @param {string} model - The model to use for generation.
 * @param {string} userPrompt - The initial user prompt.
 */
async function suggestTitle(chatId, model, userPrompt) {
    const chat = await getChat(chatId);
    if (!chat) return;

    const titleElement = document.getElementById(`title-${chatId}`);
    if (titleElement) {
        titleElement.innerHTML = `Generating title...`;
    }
    
    // Use a small, fast model for title generation if available, otherwise use selectedModel
    const generatorModel = 'phi3:mini'; // A good default title generator if available
    const titleModel = Array.from(MODEL_SELECTOR.options).some(opt => opt.value === generatorModel) 
        ? generatorModel 
        : model;

    const prompt = `Based on the following user request, create a short, descriptive title (5 words max). The title should be in English and contain no quotes or special characters: "${userPrompt}"`;
    
    try {
        const response = await fetch(`${OLLAMA_PROXY_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: titleModel,
                messages: [{ role: 'user', content: prompt }],
                options: { temperature: 0.1 } 
            }),
        });

        if (!response.ok) throw new Error("Title generation failed.");

        const data = await response.json();
        const newTitle = (data.message.content || 'Untitled Chat').trim().replace(/['"“”*#]/g, '').substring(0, 50);

        // Update the chat object and save it
        chat.title = newTitle;
        await saveChat(chat); 
        
        // Update the UI after saving
        if (titleElement) {
            titleElement.textContent = newTitle;
        }
    } catch (error) {
        console.warn("Failed to suggest title:", error.message);
        // Fallback to existing title
        if (titleElement) {
            titleElement.textContent = chat.title || 'New Chat';
        }
    }
}


// --- System Prompt Modal Logic ---

/**
 * Opens the system prompt modal and loads the current system prompt.
 */
function openSystemPromptModal() {
    if (!SYSTEM_PROMPT_MODAL || !MODAL_SYSTEM_PROMPT_INPUT) return;
    MODAL_SYSTEM_PROMPT_INPUT.value = currentSystemPrompt;
    SYSTEM_PROMPT_MODAL.classList.remove('hidden');
    MODAL_SYSTEM_PROMPT_INPUT.focus();
}

/**
 * Closes the system prompt modal.
 */
function closeSystemPromptModal() {
    if (!SYSTEM_PROMPT_MODAL) return;
    SYSTEM_PROMPT_MODAL.classList.add('hidden');
}

async function suggestTitle(chatId, model, userPrompt) {
    const titleElement = document.getElementById(`title-${chatId}`);
    if (!titleElement) return;

    titleElement.innerHTML = `Generating title... <span class="typing-indicator"></span>`;
    
    try {
        const response = await fetch(`${OLLAMA_PROXY_URL}/api/suggest_title`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model, user_prompt: userPrompt }),
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();
        const newTitle = (data.suggested_title || 'Untitled Chat').trim().replace(/['"“”]/g, '');

        // Update the chat object and save it
        const chat = await getChat(chatId);
        if (chat) {
            chat.title = newTitle;
            await saveChat(chat); 
            titleElement.textContent = newTitle;
        }
        
    } catch (error) {
        console.error('Error suggesting title:', error);
        // Fallback to existing title or temporary text
        titleElement.textContent = (await getChat(chatId))?.title || 'New Chat'; 
    }
}

/**
 * Saves the system prompt from the modal input to the global state and IndexedDB.
 */
async function saveSystemPrompt() {
    if (!MODAL_SYSTEM_PROMPT_INPUT) return;
    
    currentSystemPrompt = MODAL_SYSTEM_PROMPT_INPUT.value.trim();

    // Save the updated system prompt to the current chat's metadata
    // Since saveCurrentMessages only saves messages, we must call saveChat directly
    // by fetching the current chat object.
    const chatToUpdate = await getChat(currentChatId);
    if (chatToUpdate) {
        // currentSystemPrompt is already set globally, saveChat will pick it up.
        await saveChat(chatToUpdate);
    } 
    
    updatePersonaButtonState();
    updateSystemPromptDisplay(); 
    closeSystemPromptModal();
}

/**
 * Clears the system prompt from the global state and modal input.
 */
async function clearSystemPrompt() {
    if (!MODAL_SYSTEM_PROMPT_INPUT) return;
    
    currentSystemPrompt = '';
    MODAL_SYSTEM_PROMPT_INPUT.value = '';
    
    // Save the cleared prompt to DB
    const chatToUpdate = await getChat(currentChatId);
    if (chatToUpdate) {
        await saveChat(chatToUpdate);
    }
    
    updatePersonaButtonState();
    updateSystemPromptDisplay();
    closeSystemPromptModal();
}


// --- INITIALIZATION AND EVENT LISTENERS ---

// Expose functions globally for HTML access
window.openSystemPromptModal = openSystemPromptModal;
window.newChat = newChat;
window.sendMessage = sendMessage;
window.autoExpand = autoExpand;
// The HTML is expected to call handleFileSelect, which now uses the robust logic
window.handleFileSelect = handleFileSelect; 
window.removeAttachment = removeAttachment;

// Model selector event listener
MODEL_SELECTOR.addEventListener('change', (e) => {
    selectedModel = e.target.value;
    CURRENT_MODEL_NAME.textContent = e.target.options[e.target.selectedIndex].textContent;
    updateModelInfo(selectedModel); 
});

// System Prompt Modal Listeners
if (SYSTEM_PROMPT_MODAL) {
    SYSTEM_PROMPT_MODAL.addEventListener('click', (e) => {
        if (e.target === SYSTEM_PROMPT_MODAL) {
            closeSystemPromptModal();
        }
    });
}

if (SAVE_SYSTEM_PROMPT_BTN) {
    SAVE_SYSTEM_PROMPT_BTN.addEventListener('click', saveSystemPrompt);
}
if (CLEAR_SYSTEM_PROMPT_BTN) {
    CLEAR_SYSTEM_PROMPT_BTN.addEventListener('click', clearSystemPrompt);
}
if (CLOSE_SYSTEM_PROMPT_MODAL_BTN) {
    CLOSE_SYSTEM_PROMPT_MODAL_BTN.addEventListener('click', closeSystemPromptModal);
}

// Initializer
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await openDatabase();
        
        await fetchModels();

        const allChats = await getAllChatsMetadata();
        if (allChats.length > 0) {
            await loadChat(allChats[0].id); 
        } else {
            newChat(); 
        }

        await renderConversationList();
        
        autoExpand(PROMPT_INPUT);

    } catch (error) {
        console.error("Initialization failed:", error);
    }
});