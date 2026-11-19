// Prioritized list of models: starts with flagship Flash, falls back to fast/less congested Lite models
const MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash"
];

// 1. Define the tools Gemini is allowed to call
const AGENT_TOOLS = [{
  functionDeclarations: [
    {
      name: "fetchUnreadEmails",
      description: "Fetches the latest unread emails from Gmail inbox.",
      parameters: {
        type: "OBJECT",
        properties: {
          limit: { type: "INTEGER", description: "Max number of emails to fetch (default 5)" }
        }
      }
    },
    {
      name: "logTaskToSheet",
      description: "Logs an actionable task or summary into the tracking Google Sheet.",
      parameters: {
        type: "OBJECT",
        properties: {
          sender: { type: "STRING", description: "Email sender" },
          summary: { type: "STRING", description: "Concise summary of the request" },
          priority: { type: "STRING", description: "High, Medium, or Low" }
        },
        required: ["sender", "summary", "priority"]
      }
    },
    {
      name: "createDraftReply",
      description: "Creates a Gmail draft reply for a specific thread ID.",
      parameters: {
        type: "OBJECT",
        properties: {
          threadId: { type: "STRING", description: "The Gmail thread ID" },
          replyBody: { type: "STRING", description: "Professional response text" }
        },
        required: ["threadId", "replyBody"]
      }
    }
  ]
}];

// 2. Implement the actual Google Workspace functions
function fetchUnreadEmails(args) {
  const limit = (args && args.limit) ? args.limit : 5;
  const threads = GmailApp.search("in:inbox is:unread", 0, limit);
  
  if (threads.length === 0) {
    return { status: "No unread emails found." };
  }

  return threads.map(t => {
    const msg = t.getMessages()[0];
    return {
      threadId: t.getId(),
      sender: msg.getFrom(),
      subject: msg.getSubject(),
      snippet: msg.getPlainBody().substring(0, 600)
    };
  });
}

function logTaskToSheet(args) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  sheet.appendRow([new Date(), args.sender, args.summary, args.priority]);
  return { status: "Logged successfully" };
}

function createDraftReply(args) {
  try {
    const thread = GmailApp.getThreadById(args.threadId);
    if (!thread) {
      return { error: `Thread ID ${args.threadId} not found.` };
    }
    thread.createDraftReply(args.replyBody);
    return { status: "Draft created successfully" };
  } catch (e) {
    return { error: `Failed to create draft: ${e.message}` };
  }
}

// 3. Helper with Model Fallback + Exponential Backoff
function callGeminiWithFallback(apiKey, payload) {
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  for (const modelName of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();

    if (code === 200) {
      Logger.log(`Success using model: ${modelName}`);
      return response;
    }

    if (code === 503 || code === 429) {
      Logger.log(`[${modelName}] Busy (${code}). Switching immediately to next model...`);
      Utilities.sleep(1000); // Short 1-second pause before trying the next model
    } else {
      return response;
    }
  }

  // Final fallback attempt
  const lastUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS[0]}:generateContent?key=${apiKey}`;
  return UrlFetchApp.fetch(lastUrl, options);
}
  

// 4. The Agentic Loop (Perceive -> Reason -> Act -> Observe)
function runWorkspaceAgent() {
  const apiKey = PropertiesService.getScriptProperties().getProperty("gem_key");
  if (!apiKey) {
    Logger.log("ERROR: gem_key is missing from Script Properties.");
    return;
  }

  let conversation = [{
    role: "user",
    parts: [{
      text: "Check my latest 3 unread emails. For any email that requires action or a response, log it to the sheet with a priority level, and create a polite draft reply. Ignore newsletters or automated alerts."
    }]
  }];

  // Allow up to 6 autonomous reasoning/tool-calling steps
  for (let step = 0; step < 6; step++) {
    const payload = {
      contents: conversation,
      tools: AGENT_TOOLS,
      systemInstruction: {
        parts: [{ 
          text: "You are an autonomous executive assistant agent. Think step-by-step and use your tools to triage emails. You may call multiple tools at once when processing several emails. Log actionable job/internship alerts to the sheet, but NEVER call createDraftReply if the sender address contains 'noreply' or 'donotreply'." 
        }]
      }
    };

    const response = callGeminiWithFallback(apiKey, payload);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode !== 200) {
      Logger.log(`API Error (${responseCode}): ${responseText}`);
      break;
    }

    const result = JSON.parse(responseText);
    if (!result.candidates || result.candidates.length === 0) {
      Logger.log("API returned no candidates: " + responseText);
      break;
    }

    const candidate = result.candidates[0].content;
    conversation.push(candidate);

    // Filter for ALL function calls in this turn (supports parallel tool execution)
    const functionCallParts = candidate.parts.filter(p => p.functionCall);
    
    if (functionCallParts.length > 0) {
      const functionResponseParts = [];

      for (const part of functionCallParts) {
        const fnName = part.functionCall.name;
        const fnArgs = part.functionCall.args || {};
        
        Logger.log(`Step ${step + 1} -> Executing tool: ${fnName}`);
        
        let toolOutput;
        try {
          if (fnName === "fetchUnreadEmails") {
            toolOutput = fetchUnreadEmails(fnArgs);
          } else if (fnName === "logTaskToSheet") {
            toolOutput = logTaskToSheet(fnArgs);
          } else if (fnName === "createDraftReply") {
            toolOutput = createDraftReply(fnArgs);
          } else {
            toolOutput = { error: `Unknown function: ${fnName}` };
          }
        } catch (err) {
          toolOutput = { error: `Tool execution failed: ${err.message}` };
        }

        functionResponseParts.push({
          functionResponse: {
            name: fnName,
            response: { result: toolOutput }
          }
        });
      }

      conversation.push({
        role: "user",
        parts: functionResponseParts
      });

    } else {
      const finalText = candidate.parts.map(p => p.text).join("\n");
      Logger.log("Agent Final Report:\n" + finalText);
      break;
    }
  }
}