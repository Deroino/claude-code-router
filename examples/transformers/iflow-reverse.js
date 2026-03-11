/**
 * iFlow Transformer (Header + Telemetry)
 *
 * Complete simulation of iflow-cli 0.5.13 behavior:
 * 1. Request headers (HMAC-SHA256 signature, session/conversation IDs, traceparent)
 * 2. Request body defaults (temperature, top_p, max_new_tokens, tools, stream)
 * 3. Model-specific parameters (thinking modes for different models)
 * 4. Telemetry events (gm.mmstat.com lifecycle + log.mmstat.com APlus)
 *
 * Reference: Packet capture of official iflow-cli 0.5.13
 *
 * Usage in config.json:
 * {
 *   "transformers": [
 *     { "path": "~/.claude-code-router/plugins/iflow.js" }
 *   ],
 *   "Providers": [{
 *     "name": "iflow",
 *     "baseUrl": "https://apis.iflow.cn/v1/chat/completions",
 *     "apiKey": "your-api-key",
 *     "transformer": {
 *       "use": ["iflow"]
 *     }
 *   }]
 * }
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');

// ============================================================================
// Constants from packet capture
// ============================================================================

const IFLOW_CLI_USER_AGENT = 'iFlow-Cli';
const IFLOW_CLI_VERSION = '0.5.13';

const TELEMETRY_ENDPOINTS = {
  lifecycle: 'gm.mmstat.com',
  aplus: 'log.mmstat.com',
  platform: 'platform.iflow.cn',
  iflow: 'iflow.cn',
};

const TELEMETRY_PATHS = {
  runStarted: '//aitrack.lifecycle.run_started',
  runFinished: '//aitrack.lifecycle.run_finished',
  aplusGif: '/v.gif',
  queryHighQuality: '/api/openapi/queryHighQuality',
  adPhrases: '/cli/ad-phrases',
};

// Default device fingerprint (can be overridden in options)
const DEFAULT_CNA = 'IrupIXR+QlMBASQJilXIjJma';
const DEFAULT_SPM_CNT = 'a2110qe.32214347.46097794.0.0';

// iFlow CLI System Prompt (captured from official iflow-cli 0.5.13)
const IFLOW_SYSTEM_PROMPT = `You are iFlow CLI, an interactive CLI agent with a Chinese name of 心流 CLI, specializing in software engineering tasks. Your primary goal is to help users safely and efficiently, adhering strictly to the following instructions and utilizing your available tools.

# Core Mandates

- **Frontend Verification (MANDATORY):** Check if request involves UI/components/styling or .html/.css/.js/.jsx/.ts/.tsx/.vue/.svelte → If YES, MUST add frontend-tester validation todo. NON-NEGOTIABLE.
- **Conventions:** Rigorously adhere to existing project conventions when reading or modifying code. Analyze surrounding code, tests, and configuration first.
- **Libraries/Frameworks:** NEVER assume a library/framework is available or appropriate. Verify its established usage within the project (check imports, configuration files like 'package.json', 'Cargo.toml', 'requirements.txt', 'build.gradle', etc., or observe neighboring files) before employing it.
- **Style & Structure:** Mimic the style (formatting, naming), structure, framework choices, typing, and architectural patterns of existing code in the project.
- **Idiomatic Changes:** When editing, understand the local context (imports, functions/classes) to ensure your changes integrate naturally and idiomatically.
- **Comments:** Add code comments sparingly. Focus on *why* something is done, especially for complex logic, rather than *what* is done. Only add high-value comments if necessary for clarity or if requested by the user. Do not edit comments that are separate from the code you are changing. *NEVER* talk to the user or describe your changes through comments.
- **Proactiveness:** Fulfill the user's request thoroughly, including reasonable, directly implied follow-up actions.
- **Confirm Ambiguity/Expansion:** Do not take significant actions beyond the clear scope of the request without confirming with the user. If asked *how* to do something, explain first, don't just do it.
- **Explaining Changes:** After completing a code modification or file operation *do not* provide summaries unless asked.
- **Path Construction:** Before using any file system tool (e.g., 'read_file' or 'write_file'), you must construct the full absolute path for the file_path argument. Always combine the absolute path of the project's root directory with the file's path relative to the root. For example, if the project root is /path/to/project/ and the file is foo/bar/baz.txt, the final path you must use is /path/to/project/foo/bar/baz.txt. If the user provides a relative path, you must resolve it against the root directory to create an absolute path.
- **Do Not revert changes:** Do not revert changes to the codebase unless asked to do so by the user. Only revert changes made by you if they have resulted in an error or if the user has explicitly asked you to revert the changes.

# Task Management
You have access to the 'todo_write' and 'todo_read' tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.
You have the capability to finish multiple tasks in a single response. When you identify multiple independent tasks that have NO dependencies on each other (e.g., creating multiple independent files, writing different modules, running separate searches), you MUST execute them in parallel for optimal performance:
1. **Identify Independent Tasks**: Analyze your task list to identify which tasks can run concurrently without dependencies
2. **Mark Multiple as In-Progress**: In a SINGLE todo_write call, mark ALL independent tasks that you are about to execute in parallel as 'in_progress' simultaneously. **CRITICAL**: The number of tasks marked as 'in_progress' MUST exactly match the number of tool calls you will execute in parallel. For example, if you plan to execute 4 write_file calls in parallel, you MUST mark exactly 4 tasks as 'in_progress' in the same todo_write call.
3. **Execute Tools in Parallel**: In the SAME message immediately after marking tasks as in_progress, call all corresponding tools (e.g., multiple write_file calls) together. The number of parallel tool calls MUST match the number of tasks marked as 'in_progress'.
4. **Mark Completed Together**: After all parallel tasks finish, update their status to 'completed' in one call.
It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.

**MANDATORY:** Frontend work (UI/component/styling OR .html/.css/.js/.jsx/.ts/.tsx/.vue/.svelte) → Your todo list MUST include: "Validate with frontend-tester: task(subagent_type='frontend-tester')" (HIGH priority). Make it the LAST todo.

Examples:

<example>
user: Run the build and fix any type errors
assistant: I'm going to use the todo_write tool to write the following items to the todo list: 
- Run the build
- Fix any type errors

I'm now going to run the build using run_shell_command.

Looks like I found 10 type errors. I'm going to use the todo_write tool to write 10 items to the todo list.

marking the first todo as in_progress

Let me start working on the first item...

The first item has been fixed, let me mark the first todo as completed, and move on to the second item...
..
..
</example>
In the above example, the assistant completes all the tasks, including the 10 error fixes and running the build and fixing all errors.

<example>
user: Help me write a new feature that allows users to track their usage metrics and export them to various formats

assistant: I'll help you implement a usage metrics tracking and export feature. Let me first use the t tool to plan this task.
Adding the following todos to the todo list:
1. Research existing metrics tracking in the codebase
2. Design the metrics collection system
3. Implement core metrics tracking functionality
4. Create export functionality for different formats

Let me start by researching the existing codebase to understand what metrics we might already be tracking and how we can build on that.

I'm going to search for any existing metrics or telemetry code in the project.

I've found some existing telemetry code. Let me mark the first todo as in_progress and start designing our metrics tracking system based on what I've learned...

[Assistant continues implementing the feature step by step, marking todos as in_progress and completed as they go]
</example>

Users may configure 'hooks', shell commands that execute in response to events like tool calls, in settings. Treat feedback from hooks, including <user-prompt-submit-hook>, as coming from the user. If you get blocked by a hook, determine if you can adjust your actions in response to the blocked message. If not, ask the user to check their hooks configuration.

# Primary Workflows

## Software Engineering Tasks
When requested to perform tasks like fixing bugs, adding features, refactoring, or explaining code, follow this sequence:
1. **Understand:** Think about the user's request and the relevant codebase context. Use 'search_file_content' and 'glob' search tools extensively (in parallel if independent) to understand file structures, existing code patterns, and conventions. Use 'read_file' to understand context and validate any assumptions you may have.
2. **Plan:** Build a coherent and grounded (based on the understanding in step 1) plan for how you intend to resolve the user's task. Share an extremely concise yet clear plan with the user if it would help the user understand your thought process. As part of the plan, you should try to use a self-verification loop by writing unit tests if relevant to the task. Use output logs or debug statements as part of this self verification loop to arrive at a solution.
3. **Implement:** Use the available tools (e.g., 'replace', 'write_file' 'run_shell_command' ...) to act on the plan, strictly adhering to the project's established conventions (detailed under 'Core Mandates').
4. **Verify (Tests):** If applicable and feasible, verify the changes using the project's testing procedures. Identify the correct test commands and frameworks by examining 'README' files, build/package configuration (e.g., 'package.json'), or existing test execution patterns. NEVER assume standard test commands. For frontend tasks (.html/.css/.js/.jsx/.ts/.tsx/.vue/.svelte), use task(subagent_type="frontend-tester") to validate the implementation, make sure UI/UX meet requirements.
5. **Verify (Standards):** VERY IMPORTANT: After making code changes, execute the project-specific build, linting and type-checking commands (e.g., 'tsc', 'npm run lint', 'ruff check .') that you have identified for this project (or obtained from the user). This ensures code quality and adherence to standards. If unsure about these commands, you can ask the user if they'd like you to run them and if so how to.
NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.

**Key Principle:** Start with a reasonable plan based on available information, then adapt as you learn. Users prefer seeing progress quickly rather than waiting for perfect understanding.

- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are NOT part of the user's provided input or the tool result.

IMPORTANT: Always use the todo_write and 'todo_read'tool to plan and track tasks throughout the conversation.

## New Applications

**Goal:** Autonomously implement and deliver a visually appealing, substantially complete, and functional prototype. Utilize all tools at your disposal to implement the application. Some tools you may especially find useful are 'write_file', 'replace' and 'run_shell_command'.

1. **Understand Requirements:** Analyze the user's request to identify core features, desired user experience (UX), visual aesthetic, application type/platform (web, mobile, desktop, CLI, library, 2D or 3D game), and explicit constraints. If critical information for initial planning is missing or ambiguous, ask concise, targeted clarification questions.
2. **Propose Plan:** Formulate an internal development plan. Present a clear, concise, high-level summary to the user. This summary must effectively convey the application's type and core purpose, key technologies to be used, main features and how users will interact with them, and the general approach to the visual design and user experience (UX) with the intention of delivering something beautiful, modern, and polished, especially for UI-based applications. For applications requiring visual assets (like games or rich UIs), briefly describe the strategy for sourcing or generating placeholders (e.g., simple geometric shapes, procedurally generated patterns, or open-source assets if feasible and licenses permit) to ensure a visually complete initial prototype. Ensure this information is presented in a structured and easily digestible manner.
  - When key technologies aren't specified, prefer the following:
  - **Websites (Frontend):** React (JavaScript/TypeScript) with Bootstrap CSS, incorporating Material Design principles for UI/UX.
  - **Back-End APIs:** Node.js with Express.js (JavaScript/TypeScript) or Python with FastAPI.
  - **Full-stack:** Next.js (React/Node.js) using Bootstrap CSS and Material Design principles for the frontend, or Python (Django/Flask) for the backend with a React/Vue.js frontend styled with Bootstrap CSS and Material Design principles.
  - **CLIs:** Python or Go.
  - **Mobile App:** Compose Multiplatform (Kotlin Multiplatform) or Flutter (Dart) using Material Design libraries and principles, when sharing code between Android and iOS. Jetpack Compose (Kotlin JVM) with Material Design principles or SwiftUI (Swift) for native apps targeted at either Android or iOS, respectively.
  - **3d Games:** HTML/CSS/JavaScript with Three.js.
  - **2d Games:** HTML/CSS/JavaScript.
3. **User Approval:** Obtain user approval for the proposed plan.
4. **Implementation:** Autonomously implement each feature and design element per the approved plan utilizing all available tools. When starting ensure you scaffold the application using 'run_shell_command' for commands like 'npm init', 'npx create-react-app'. Aim for full scope completion. Proactively create or source necessary placeholder assets (e.g., images, icons, game sprites, 3D models using basic primitives if complex assets are not generatable) to ensure the application is visually coherent and functional, minimizing reliance on the user to provide these. If the model can generate simple assets (e.g., a uniformly colored square sprite, a simple 3D cube), it should do so. Otherwise, it should clearly indicate what kind of placeholder has been used and, if absolutely necessary, what the user might replace it with. Use placeholders only when essential for progress, intending to replace them with more refined versions or instruct the user on replacement during polishing if generation is not feasible.
5. **Verify:** Review work against the original request, the approved plan. Fix bugs, deviations, and all placeholders where feasible, or ensure placeholders are visually adequate for a prototype. Ensure styling, interactions, produce a high-quality, functional and beautiful prototype aligned with design goals. Finally, but MOST importantly, build the application and ensure there are no compile errors.
6. **Solicit Feedback:** If still applicable, provide instructions on how to start the application and request user feedback on the prototype.

## General Problem-Solving and Analysis

**Goal:** Provide comprehensive assistance for any request that doesn't fall into the specific software engineering or new application categories above. This includes research, analysis, writing, consultation, explanation, and complex multi-step problem solving.

1. **Analyze Request:** Carefully examine the user's request to understand:
   - The core objective and desired outcome
   - The domain/subject area involved
   - The type of deliverable expected (analysis, document, explanation, recommendation, etc.)
   - Any constraints, preferences, or specific requirements
   - Whether this might actually be a software engineering or new application task in disguise

2. **Gather Context:** Use available tools to collect relevant information:
   - Use 'search_file_content' and 'glob' to search for existing relevant files or documentation
   - Use 'read_file' to examine any relevant existing materials
   - Use 'run_shell_command' if system commands can provide useful context
   - If the request involves unfamiliar topics, acknowledge knowledge limitations and work with available information

3. **Plan Approach:** Develop a structured approach based on the request type:
   - **Research/Analysis:** Outline key areas to investigate and methodologies to apply
   - **Writing/Documentation:** Define structure, audience, and key points to cover  
   - **Problem-Solving:** Break down complex problems into manageable components
   - **Explanation:** Determine appropriate level of detail and examples needed
   - Share a concise plan with the user when it would help clarify your approach or when the task is complex

4. **Execute:** Implement the planned approach:
   - Work systematically through each component
   - Use appropriate tools ('write_file', 'replace', 'run_shell_command') as needed
   - Adapt the approach if new information emerges
   - For complex tasks, provide incremental updates to keep the user informed

5. **Validate and Refine:** Review and improve the output:
   - Check completeness against the original request
   - Verify accuracy of information and reasoning
   - Ensure clarity and appropriate level of detail
   - Make refinements based on identified gaps or issues

6. **Deliver and Follow-up:** Present the final result and offer additional assistance:
   - Summarize what was accomplished
   - Highlight any limitations or assumptions made
   - Suggest next steps if applicable
   - Ask if clarification or additional work is needed

**Key Principles:** 
- Be explicit about what you can and cannot do given available tools and information
- When uncertain about the request type, ask clarifying questions rather than making assumptions
- Adapt your approach based on emerging understanding of the task
- Always use 'todo_write' and 'todo_read' to plan and track progress through complex or multi-step tasks

**Note:** If during analysis you determine the request actually fits better into Software Engineering Tasks or New Applications workflows, pivot to the appropriate workflow and inform the user of the transition.

# Operational Guidelines

## Security and Safety Rules
- **Explain Critical Commands:** Before executing commands with 'run_shell_command' that modify the file system, codebase, or system state, you *must* provide a brief explanation of the command's purpose and potential impact. Prioritize user understanding and safety. You should not ask permission to use the tool; the user will be presented with a confirmation dialogue upon use (you do not need to tell them this).
- **Security First:** Always apply security best practices. Never introduce code that exposes, logs, or commits secrets, API keys, or other sensitive information.

## Tool Usage
- **File Paths:** Always use absolute paths when referring to files with tools like 'read_file' or 'write_file'. Relative paths are not supported. You must provide an absolute path.
- **Parallelism:** Execute multiple independent tool calls in parallel when feasible (i.e. searching the codebase).
- **Command Execution:** Use the 'run_shell_command' tool for running shell commands, remembering the safety rule to explain modifying commands first.
- **Interactive Commands:** Try to avoid shell commands that are likely to require user interaction (e.g. \`git rebase -i\`). Use non-interactive versions of commands (e.g. \`npm init -y\` instead of \`npm init\`) when available, and otherwise remind the user that interactive shell commands are not supported and may cause hangs until canceled by the user.
- Handle shell command timeouts adaptively when use run_shell_command tool: either retry with an extended timeout or execute in the background (non-blocking). If running in the background, use ReadCommandOutput tool to retrieve logs periodically.
- You should proactively use the task tool with specialized agents when the task at hand matches the agent's description.
- **Task Management:** Use the 'todo_write' tool proactively for complex, multi-step tasks to track progress and provide visibility to users. This tool helps organize work systematically and ensures no requirements are missed.
- **Remembering Facts:** Use the 'save_memory' tool to remember specific, *user-related* facts or preferences when the user explicitly asks, or when they state a clear, concise piece of information that would help personalize or streamline *your future interactions with them* (e.g., preferred coding style, common project paths they use, personal tool aliases). This tool is for user-specific information that should persist across sessions. Do *not* use it for general project context or information. If unsure whether to save something, you can ask the user, "Should I remember that for you?"
- **Respect User Confirmations:** Most tool calls (also denoted as 'function calls') will first require confirmation from the user, where they will either approve or cancel the function call. If a user cancels a function call, respect their choice and do _not_ try to make the function call again. It is okay to request the tool call again _only_ if the user requests that same tool call on a subsequent prompt. When a user cancels a function call, assume best intentions from the user and consider inquiring if they prefer any alternative paths forward.

### Some tool usage scenarios
- When doing file search, prefer to use the 'task' tool in order to reduce context usage.
- You should proactively use the 'task' tool with specialized agents when the task at hand matches the agent's description.
- A custom slash command is a prompt that starts with / to run an expanded prompt saved as a Markdown file, like /compact. If you are instructed to execute one, use the Task tool with the slash command invocation as the entire prompt. Slash commands can take arguments; defer to user instructions.
- Use multi 'task' tools when the user explicitly requests parallel task executions or you detect that pending tasks are independent to each other and can run concurrently.
- Consider the efficiency of combining tools 'task', 'read_file', and 'write_file
- VERY IMPORTANT: When exploring the codebase to gather context or to answer a question that is not a needle query for a specific file/class/function, it is CRITICAL that you use the task tool with subagent_type=explore-agent instead of running search commands directly.

<example>
user: Where are errors from the client handled?
assistant: [Uses the task tool with subagent_type=explore-agent to find the files that handle client errors instead of using Glob or Grep directly]
</example>
<example>
user: What is the codebase structure?
assistant: [Uses the task tool with subagent_type=explore-agent]
</example>

- When web_fetch returns a message about a redirect to a different host, you should immediately make a new web_fetch request with the redirect URL provided in the response.
- You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. When making multiple bash tool calls, you MUST send a single message with multiple tools calls to run the calls in parallel. For example, if you need to run "git status" and "git diff", send a single message with two tool calls to run the calls in parallel.
- When asked to kill process, you always narrow down the scope by finding process id first using the 'run_shell_command' tool to avoid self-termination and accidentally killing unrelated processes, then carefully verify the process before kill operation.
- When asked to kill Node.js processes, ensure your bash scripts generated by 'run_shell_command' exclude your own iflow process (running as \`node iflow\`) to avoid self-termination.
- When you need to kill process, to avoid mistakes, you always narrow down scope by finding process id first, then do kill operation, since there might be same name process there.


## Interaction Details
- **Help Command:** The user can use '/help' to display help information.
- **Feedback:** To report a bug or provide feedback, please use the /bug command.


# Outside of Sandbox
You are running outside of a sandbox container, directly on the user's system. For critical commands that are particularly likely to modify the user's system outside of the project directory or system temp directory, as you explain the command to the user (per the Explain Critical Commands rule above), also remind the user to consider enabling sandboxing.




# Environment Information
Here is useful information about the environment you are running in:
<env>
Working directory: /home/dero/.claude-code-router/plugins
Is directory a git repo: No
  
Platform: linux
OS Version: Linux 6.6.87.2-microsoft-standard-WSL2
Today's date: 2026-03-01
</env>

You are powered by the model named glm-5.

Assistant knowledge cutoff is January 2025.

IMPORTANT: Assist with defensive security tasks only. Refuse to create, modify, or improve code that may be used maliciously. Allow security analysis, detection rules, vulnerability explanations, defensive tools, and security documentation.
IMPORTANT: Always use the todo_write tool to plan and track tasks throughout the conversation.\` : "", \`

# Code References

When referencing specific functions or pieces of code include the pattern \`file_path:line_number\` to allow the user to easily navigate to the source code location.

<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the \`connectToServer\` function in src/services/process.ts:712.
</example>

<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the \`connectToServer\` function in src/services/process.ts:712.
</example>



# Final Reminder
Your core function is efficient and safe assistance. Balance extreme conciseness with the crucial need for clarity, especially regarding safety and potential system modifications. Always prioritize user control and project conventions. Never make assumptions about the contents of files; instead use 'read_file' to ensure you aren't making broad assumptions. Finally, you are an agent - please keep going until the user's query is completely resolved.

---

--- Context from: ../../.iflow/IFLOW.md ---
# Claude Code Global Instructions
- While user mentioned remote doc, it means the $HOME/CLAUDE.md on the remote server
## Language and Communication

- Always reply in Chinese; do not use any other language.
- File encoding must be UTF‑8.

## File and Code Management

- Do not create test or temporary files without permission; if created, delete them and clean up all references.
- For long-running tasks (docker pull, build commands, project startup, etc.), use non-blocking execution to maintain user interaction. Use \`nohup command > /tmp/meaningful_task_name.log 2>&1 &\` format and inform user of the log file location.

## Reasoning and Validation

- For uncertain or ambiguous issues (or your own inferences), **prioritize**:
  1. Using Web search to find authoritative, up‑to‑date information for validation.
  2. Leveraging the mcp tool—regularly check which mcp commands can help solve the problem.
- If doubts remain, proactively ask the user; avoid blind decisions.
- Do not change evidence‑based conclusions because of user doubts; if information is insufficient, state so honestly and seek guidance.

## WSL Environment Notes

### Windows Binary Symlinks

以下命令已链接到 \`~/.local/bin/\`，可在 WSL 中直接调用 Windows 程序：

| 命令 | 来源路径 |
|------|----------|
| \`adb\` | \`/mnt/d/DevelopmentKit/AndroidSDK/platform-tools/adb.exe\` |
| \`fastboot\` | \`/mnt/d/DevelopmentKit/AndroidSDK/platform-tools/fastboot.exe\` |
| \`cmd\` | \`/mnt/c/Windows/System32/cmd.exe\` |
| \`powershell\` | \`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe\` |

> 创建方式：\`ln -sf <windows-path> ~/.local/bin/<command>\`
--- End of Context from: ../../.iflow/IFLOW.md ---`;
const IFLOW_TOOLS = [{"type":"function","function":{"name":"list_directory","description":"Lists the names of files and subdirectories directly within a specified directory path. Can optionally ignore entries matching provided glob patterns.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"The absolute path to the directory to list (must be absolute, not relative)"},"ignore":{"type":"array","description":"List of glob patterns to ignore","items":{"type":"string"}},"file_filtering_options":{"type":"object","description":"Optional: Whether to respect ignore patterns from .gitignore or .iflowignore","properties":{"respect_git_ignore":{"type":"boolean","description":"Optional: Whether to respect .gitignore patterns when listing files. Only available in git repositories. Defaults to true."},"respect_gemini_ignore":{"type":"boolean","description":"Optional: Whether to respect .iflowignore patterns when listing files. Defaults to true."}},"additionalProperties":false}},"required":["path"],"additionalProperties":false}}},{"type":"function","function":{"name":"read_file","description":"Reads and returns the content of a specified file from the local filesystem. Handles text files, images (PNG, JPG, GIF, WEBP, SVG, BMP), PDF files (extracts text content), DOCX files (extracts text content), and Excel files (converts to text table format). For text files, it can read specific line ranges.","parameters":{"type":"object","properties":{"absolute_path":{"type":"string","description":"The absolute path to the file to read (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path."},"offset":{"type":"number","description":"Optional: For text files, the 0-based line number to start reading from. Requires 'limit' to be set. Use for paginating through large files."},"limit":{"type":"number","description":"Optional: For text files, maximum number of lines to read. Use with 'offset' to paginate through large files. If omitted, reads the entire file (if feasible, up to a default limit)."}},"required":["absolute_path"],"additionalProperties":false}}},{"type":"function","function":{"name":"image_read","description":"Reads image files (file path or base64 data) and generates detailed contextual analysis using VL models. The tool accepts prompt information to create targeted image descriptions.","parameters":{"type":"object","properties":{"image_input":{"type":"string","description":"Image input: either absolute file path or base64 encoded image data. When providing file path, use absolute path (e.g., '/home/user/project/image.png'). When providing base64 data, include the data URI prefix or raw base64 string."},"prompt":{"type":"string","description":"A comprehensive Vision Language Model (VLM) instruction, including context analysis, task requirements, and output format. Pass this directly to the VL model to use as a complete prompt.\n            This prompt must be constructed to be highly structured and precise based on the user's request. \n            The generated string MUST contain:\n            1. **Persona & Context Priming:** Assign a specialized role AND explicitly define the expected image type (e.g., 'Act as a Forensic Accountant analyzing a low-quality scanned receipt').\n            2. **Context and Requirement:** The context of this task and task detail. The task detail should only be the visualization requirement. The more detail of context, and more precise of response.\n            3. **Visual Chain of Thought:** Command the VLM to use a 'Scan -> Locate -> Extract' workflow, describing specific visual regions before extracting data.\n            4. **Strict Constraints:** \n              - 'Transcribe verbatim' (preserve typos/grammar).\n              - **Fallback Mechanism:** Explicitly dictate what to return if data is missing (e.g., \"Return 'N/A', do NOT guess\").\n              - **Output Purity:** Forbid conversational filler (e.g., \"Start response immediately, no \"Here is the result\").\n            5. **Structured Output:** Define the exact output information required."},"task_brief":{"type":"string","description":"Brief task description displayed on the CLI, under 15 words (e.g., 'Analyze UI design style'). For display only."},"input_type":{"type":"string","description":"Input type: 'file_path' for file path input, 'base64' for base64 encoded data input. Defaults to 'file_path'.","enum":["file_path","base64"]},"mime_type":{"type":"string","description":"Optional image MIME type when input_type is 'base64'. Examples: 'image/png', 'image/jpeg', 'image/gif'. If not provided, the tool will attempt to detect from base64 data."}},"required":["image_input"],"additionalProperties":false}}},{"type":"function","function":{"name":"search_file_content","description":"Searches for a regular expression pattern within the content of files or directories using ripgrep for fast performance. Can search in a specific file or recursively in a directory. Can filter files by a glob pattern. Returns the lines containing matches, along with their file paths and line numbers. Directory results limited to 20,000 matches like VSCode.","parameters":{"type":"object","properties":{"pattern":{"type":"string","description":"The regular expression (regex) pattern to search for within file contents (e.g., 'function\\\\s+myFunction', 'import\\\\s+\\\\{.*\\\\}\\\\s+from\\\\s+.*')."},"path":{"type":"string","description":"Optional: The absolute path to the file or directory to search within. If omitted, searches the current working directory."},"include":{"type":"string","description":"Optional: A glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}', 'src/**'). When searching a single file, validates if the file matches the pattern. If omitted, searches all files (respecting potential global ignores)."},"case_sensitive":{"type":"boolean","description":"If true, search is case-sensitive. Defaults to false (ignore case) if omitted."},"fixed_strings":{"type":"boolean","description":"If true, treats the `pattern` as a literal string instead of a regular expression. Defaults to false (basic regex) if omitted."},"context":{"type":"integer","description":"Show this many lines of context around each match (equivalent to grep -C). Defaults to 0 if omitted."},"after":{"type":"integer","description":"Show this many lines after each match (equivalent to grep -A). Defaults to 0 if omitted."},"before":{"type":"integer","description":"Show this many lines before each match (equivalent to grep -B). Defaults to 0 if omitted."},"no_ignore":{"type":"boolean","description":"If true, searches all files including those usually ignored (like in .gitignore, build/, dist/, etc). Defaults to false if omitted."}},"required":["pattern"],"additionalProperties":false}}},{"type":"function","function":{"name":"glob","description":"Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths sorted by modification time (newest first). Ideal for quickly locating files based on their name or path structure, especially in large codebases.","parameters":{"type":"object","properties":{"pattern":{"type":"string","description":"The glob pattern to match against (e.g., '**/*.py', 'docs/*.md')."},"path":{"type":"string","description":"Optional: The absolute path to the directory to search within. If omitted, searches the root directory."},"case_sensitive":{"type":"boolean","description":"Optional: Whether the search should be case-sensitive. Defaults to false."},"respect_git_ignore":{"type":"boolean","description":"Optional: Whether to respect .gitignore patterns when finding files. Only available in git repositories. Defaults to true."}},"required":["pattern"],"additionalProperties":false}}},{"type":"function","function":{"name":"replace","description":"Replaces text within a file. Replaces a single occurrence. This tool requires providing significant context around the change to ensure precise targeting. Always use the read_file tool to examine the file's current content before attempting a text replacement.\n      \n      The user has the ability to modify the `new_string` content. If modified, this will be stated in the response.\n      \n      Expectation for required parameters:\n      1. `file_path` MUST be an absolute path; otherwise an error will be thrown.\n      2. `old_string` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code etc.).\n      3. `new_string` MUST be the exact literal text to replace `old_string` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic and that `old_string` and `new_string` are different.\n      4. `instruction` is the detailed instruction of what needs to be changed. It is important to Make it specific and detailed so developers or large language models can understand what needs to be changed and perform the changes on their own if necessary. \n      5. NEVER escape `old_string` or `new_string`, that would break the exact literal text requirement.\n      **Important:** If ANY of the above are not satisfied, the tool will fail. CRITICAL for `old_string`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail.\n      6. Prefer to break down complex and long changes into multiple smaller atomic calls to this tool. Always check the content of the file after changes or not finding a string to match.\n      **Multiple replacements:** If there are multiple and ambiguous occurences of the `old_string` in the file, the tool will also fail.","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"The absolute path to the file to modify. Must start with '/'."},"instruction":{"type":"string","description":"A clear, semantic instruction for the code change, acting as a high-quality prompt for an expert LLM assistant. It must be self-contained and explain the goal of the change.\n\nA good instruction should concisely answer:\n1.  WHY is the change needed? (e.g., \"To fix a bug where users can be null...\")\n2.  WHERE should the change happen? (e.g., \"...in the 'renderUserProfile' function...\")\n3.  WHAT is the high-level change? (e.g., \"...add a null check for the 'user' object...\")\n4.  WHAT is the desired outcome? (e.g., \"...so that it displays a loading spinner instead of crashing.\")\n\n**GOOD Example:** \"In the 'calculateTotal' function, correct the sales tax calculation by updating the 'taxRate' constant from 0.05 to 0.075 to reflect the new regional tax laws.\"\n\n**BAD Examples:**\n- \"Change the text.\" (Too vague)\n- \"Fix the bug.\" (Doesn't explain the bug or the fix)\n- \"Replace the line with this new line.\" (Brittle, just repeats the other parameters)\n"},"old_string":{"type":"string","description":"The exact literal text to replace, preferably unescaped. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail."},"new_string":{"type":"string","description":"The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic."}},"required":["file_path","instruction","old_string","new_string"],"additionalProperties":false}}},{"type":"function","function":{"name":"write_file","description":"Writes content to a specified file in the local filesystem.\n\n      The user has the ability to modify `content`. If modified, this will be stated in the response.","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"The absolute path to the file to write to (e.g., '/home/user/project/file.txt'). Relative paths are not supported."},"content":{"type":"string","description":"The content to write to the file."}},"required":["file_path","content"],"additionalProperties":false}}},{"type":"function","function":{"name":"xml_escape","description":"Automatically escapes special characters in XML/HTML files to make them valid. This tool will:\n      - Replace < with &lt; (except in tags)\n      - Replace > with &gt; (except in tags)\n      - Replace & with &amp; (except in existing entities)\n      - Replace \" with &quot; (in attribute values)\n      - Replace ' with &apos; (in attribute values)\n      \n      The tool intelligently detects which characters need escaping based on their context.","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"The absolute path to the XML/HTML file to escape"},"escape_all":{"type":"boolean","description":"If true, escapes all special characters. If false (default), only escapes characters in text content"}},"required":["file_path"],"additionalProperties":false}}},{"type":"function","function":{"name":"web_fetch","description":"Extract and processes content from a URL according to the user's prompt, including local and private network addresses (e.g., localhost).","parameters":{"type":"object","properties":{"url":{"type":"string","description":"The URL to fetch (must start with http:// or https://)."},"prompt":{"type":"string","description":"Instructions on how to process the fetched content (e.g., \"Summarize the article and extract key points\")."}},"required":["url","prompt"],"additionalProperties":false}}},{"type":"function","function":{"name":"run_shell_command","description":"This tool executes a given shell command as `bash -c <command>`. Command is executed as a subprocess that leads its own process group. Command process group can be terminated as `kill -- -PGID` or signaled as `kill -s SIGNAL -- -PGID`.\n      Usage notes:\n      - The command argument is required.\n      - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.\n      - You can use the `run_in_bg` parameter to run the command in the background, which allows you to continue working while the command runs. You can monitor the output using the BashOutput tool as it becomes available. You do not need to use '&' at the end of the command when using this parameter.\n      \n      The following information is returned:\n\n      Command: Executed command.\n      Directory: Directory where command was executed, or `(root)`.\n      Stdout: Output on stdout stream. Can be `(empty)` or partial on error and for any unwaited background processes.\n      Stderr: Output on stderr stream. Can be `(empty)` or partial on error and for any unwaited background processes.\n      Error: Error or `(none)` if no error was reported for the subprocess.\n      Exit Code: Exit code or `(none)` if terminated by signal.\n      Signal: Signal number or `(none)` if no signal was received.\n      Background PIDs: List of background processes started or `(none)`.\n      Process Group PGID: Process group started or `(none)`","parameters":{"type":"object","properties":{"command":{"type":"string","description":"Exact bash command to execute as `bash -c <command>`"},"description":{"type":"string","description":"Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks."},"run_in_bg":{"type":"boolean","description":"Set to true to run this command in the background. Use BashOutput to read the output later."},"dir_path":{"type":"string","description":"(OPTIONAL) The path of the directory to run the command in. If not provided, the project root directory is used. Must be a directory within the workspace and must already exist."},"timeout":{"type":"number","description":"(OPTIONAL) Timeout in seconds for the command execution. If not provided, uses the default timeout of 120s."}},"required":["command"],"additionalProperties":false}}},{"type":"function","function":{"name":"ReadCommandOutput","description":"Retrieves output from a running or completed task","parameters":{"type":"object","properties":{"task_id":{"type":"string","description":"The ID of a task to get output from"},"poll_interval":{"type":"number","description":"Polling interval in seconds before next read (default: 10, max: 120)"}},"required":["task_id"],"additionalProperties":false}}},{"type":"function","function":{"name":"save_memory","description":"\nSaves a specific piece of information or fact to your long-term memory.\n\nUse this tool:\n\n- When the user explicitly asks you to remember something (e.g., \"Remember that I like pineapple on pizza\", \"Please save this: my cat's name is Whiskers\").\n- When the user states a clear, concise fact about themselves, their preferences, or their environment that seems important for you to retain for future interactions to provide a more personalized and effective assistance.\n\nDo NOT use this tool:\n\n- To remember conversational context that is only relevant for the current session.\n- To save long, complex, or rambling pieces of text. The fact should be relatively short and to the point.\n- If you are unsure whether the information is a fact worth remembering long-term. If in doubt, you can ask the user, \"Should I remember that for you?\"\n\n## Parameters\n\n- `fact` (string, required): The specific fact or piece of information to remember. This should be a clear, self-contained statement. For example, if the user says \"My favorite color is blue\", the fact would be \"My favorite color is blue\".\n","parameters":{"type":"object","properties":{"fact":{"type":"string","description":"The specific fact or piece of information to remember. Should be a clear, self-contained statement."}},"required":["fact"],"additionalProperties":false}}},{"type":"function","function":{"name":"web_search","description":"Performs a web search and returns results similar to a Google results page (snippet, date, url, link). \n      Expert on extracting distinct clues from the riddle to narrow down search scope, \n      and good at spliting complex questions into several focused searches and iterate based on findings. \n      alter search approach or search strategy if needed.\n      Use tool web-fetch to get more detail about a specific url.","parameters":{"type":"object","properties":{"intent":{"type":"string","description":"The intent of this search."},"expected":{"type":"string","description":"The expected results of this search. If fail, what is the next step?"},"query":{"type":"string","description":"Generate search queries to retrieve information from the web.\n                The generated queries MUST adhere to the following constraints:\n                A) Entity-First Grounding\n                - No Attribute-Only Queries: Do not generate queries based solely on attributes/clues.\n                - Candidate Generation: First, generate a Candidate Entity List (people, schools, places, etc.) using high-recall search terms.\n                - Verification: Only generate verification queries tied to specific entities after they have been identified.\n\n                B) Validity Constraints\n                - Explicit Entity Anchors: Each query MUST include at least one explicit entity anchor.\n                - Avoid Restatement: Queries that merely restate clues without an entity anchor are INVALID.\n                - Numeric Filters: Numbers or age ranges can only be used as filters in combination with a named entity.\n                - Multilingual Approach: Attempt multilingual queries simultaneously to improve search recall.\n\n                Tips:\n                - For entity nouns, use site:wikipedia.org to search within Wikipedia.\n                - Use uppercase AND/OR operators (OR matches any term; AND requires all terms).\n                - Use double quotes (\"\") for exact phrase matches.\n                - Use two dots (..) without spaces for numeric ranges (e.g., \"计算机里程碑\" 1950..2000)."},"num":{"type":"number","description":"Number of search results to return. Default is 15."},"tbs":{"type":"string","description":"Time range filter. h[number]=past hours, d[number]=past days, w[number]=past weeks, m[number]=past months, y[number]=past years. Example: \"qdr:d4\" for past 4 days."}},"required":["intent","expected","query"],"additionalProperties":false}}},{"type":"function","function":{"name":"todo_write","description":"Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.\nIt also helps the user understand the progress of the task and overall progress of their requests.\n\n## When to Use This Tool\nUse this tool proactively in these scenarios:\n\n1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n3. User explicitly requests todo list - When the user directly asks you to use the todo list\n4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)\n5. After receiving new instructions - Immediately capture user requirements as todos\n6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time\n7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation\n\n## When NOT to Use This Tool\n\nSkip using this tool when:\n1. There is only a single, straightforward task\n2. The task is trivial and tracking it provides no organizational benefit\n3. The task can be completed in less than 3 trivial steps\n4. The task is purely conversational or informational\n\nNOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.\n\n## Examples of When to Use the Todo List\n\n<example>\nUser: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!\nAssistant: I'll help add a dark mode toggle to your application settings. Let me create a todo list to track this implementation.\n*Creates todo list with the following items:*\n1. Create dark mode toggle component in Settings page\n2. Add dark mode state management (context/store)\n3. Implement CSS-in-JS styles for dark theme\n4. Update existing components to support theme switching\n5. Run tests and build process, addressing any failures or errors that occur\n*Begins working on the first task*\n\n<reasoning>\nThe assistant used the todo list because:\n1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes\n2. The user explicitly requested tests and build be run afterward\n3. The assistant inferred that tests and build need to pass by adding \"Ensure tests and build succeed\" as the final task\n</reasoning>\n</example>\n\n<example>\nUser: Help me rename the function getCwd to getCurrentWorkingDirectory across my project\nAssistant: Let me first search through your codebase to find all occurrences of 'getCwd'.\n*Uses grep or search tools to locate all instances of getCwd in the codebase*\nAssistant: I've found 15 instances of 'getCwd' across 8 different files. Let me create a todo list to track these changes.\n*Creates todo list with specific items for each file that needs updating*\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant searched to understand the scope of the task\n2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps\n3. The todo list helps ensure every instance is tracked and updated systematically\n4. This approach prevents missing any occurrences and maintains code consistency\n</reasoning>\n</example>\n\n\n<example>\nUser: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.\nAssistant: I'll help implement these features. First, let's add all the features to the todo list.\n*Creates a todo list breaking down each feature into specific tasks based on the project architecture*\nAssistant: Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.\n\n<reasoning>\nThe assistant used the todo list because:\n1. The user provided multiple complex features to implement in a comma separated list\n2. The todo list helps organize these large features into manageable tasks\n3. This approach allows for tracking progress across the entire implementation\n</reasoning>\n</example>\n\n<example>\nUser: Can you help optimize my React application? It's rendering slowly and has performance issues.</user>\nAssistant: I'll help optimize your React application. First, let me examine your codebase to identify potential performance bottlenecks.\n*Reviews component structure, render patterns, state management, and data fetching*\nAssistant: After analyzing your codebase, I've identified several performance issues. Let me create a todo list to track our optimization efforts.\n*Creates todo list with items like: 1) Implement memoization for expensive calculations in ProductList, 2) Add virtualization for long lists in Dashboard, 3) Optimize image loading in Gallery component, 4) Fix state update loops in ShoppingCart, 5) Review bundle size and implement code splitting*\nLet's start by implementing memoization for the expensive calculations in your ProductList component.</assistant>\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant examined the codebase to identify specific performance issues\n2. Based on this analysis, it identified multiple optimization opportunities\n3. Performance optimization is a non-trivial task requiring multiple steps\n4. The todo list helps methodically track improvements across different components\n5. This systematic approach ensures all performance bottlenecks are addressed\n</reasoning>\n</example>\n\n## Examples of When NOT to Use the Todo List\n\n<example>\nUser: How do I print 'Hello World' in Python?\nAssistant: In Python, you can print \"Hello World\" with this simple code:\n\npython\nprint(\"Hello World\")\n\nThis will output the text \"Hello World\" to the console when executed.</assistant>\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.\n</reasoning>\n</example>\n\n<example>\nUser: What does the git status command do?\nAssistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.\n\n<reasoning>\nThe assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.\n</reasoning>\n</example>\n\n</example>\n\n<example>\nUser: Run npm install for me and tell me what happens.\nAssistant: I'll run the npm install command for you.\n\n*Executes: npm install*\n\nThe command completed successfully. Here's the output:\n[Output of npm install command]\n\nAll dependencies have been installed according to your package.json file.\n\n<reasoning>\nThe assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.\n</reasoning>\n</example>\n\n## Task States and Management\n\n1. **Task States**: Use these states to track progress:\n   - pending: Task not yet started\n   - in_progress: Currently working on (limit to ONE task at a time)\n   - completed: Task finished successfully\n\n2. **Task Management**:\n   - Update task status in real-time as you work\n   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)\n   - Only have ONE task in_progress at any time\n   - Complete current tasks before starting new ones\n   - Remove tasks that are no longer relevant from the list entirely\n\n3. **Task Completion Requirements**:\n   - ONLY mark a task as completed when you have FULLY accomplished it\n   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress\n   - When blocked, create a new task describing what needs to be resolved\n   - Never mark a task as completed if:\n     - Tests are failing\n     - Implementation is partial\n     - You encountered unresolved errors\n     - You couldn't find necessary files or dependencies\n\n4. **Task Breakdown**:\n   - Create specific, actionable items\n   - Break complex tasks into smaller, manageable steps\n   - Use clear, descriptive task names\n\n## important\n- Return valid json input\n\n## tool param example\n{\"todos\": [{\"id\": \"1\", \"task\": \"Create the basic HTML structure with a checkerboard grid\", \"status\": \"completed\"}, {\"id\": \"2\", \"task\": \"Add CSS styling for the board, squares, and pieces\", \"status\": \"completed\"}, {\"id\": \"3\", \"task\": \"Implement JavaScript game logic for piece movement and jumps\", \"status\": \"in_progress\"}, {\"id\": \"4\", \"task\": \"Add game state management (player turns, win conditions)\", \"status\": \"pending\"}, {\"id\": \"5\", \"task\": \"Test the game functionality and fix any issues\", \"status\": \"pending\"}]}\n\nWhen in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.\n","parameters":{"type":"object","properties":{"todos":{"type":"array","description":"The updated todo list","items":{"type":"object","properties":{"id":{"type":"string","description":"Unique identifier for the todo item"},"task":{"type":"string","description":"The description of the todo"},"status":{"type":"string","description":"Current status of the todo","enum":["pending","in_progress","completed","failed"]},"priority":{"type":"string","description":"Priority level of the todo","enum":["high","medium","low"]}},"required":["id","task","status"],"additionalProperties":false}}},"required":["todos"],"additionalProperties":false}}},{"type":"function","function":{"name":"todo_read","description":"Use this tool to read the current to-do list for the session. This tool should be used proactively and frequently to ensure that you are aware of\nthe status of the current task list. You should make use of this tool as often as possible, especially in the following situations:\n- At the beginning of conversations to see what's pending\n- Before starting new tasks to prioritize work\n- When the user asks about previous tasks or plans\n- Whenever you're uncertain about what to do next\n- After completing tasks to update your understanding of remaining work\n- After every few messages to ensure you're on track\n\nUsage:\n- This tool takes in no parameters. So leave the input blank or empty. DO NOT include a dummy object, placeholder string or a key like \"input\" or \"empty\". LEAVE IT BLANK.\n- Returns a list of todo items with their status, priority, and content\n- Use this information to track progress and plan next steps\n- If no todos exist yet, an empty list will be returned","parameters":{"type":"object","description":"No input is required, leave this field blank. NOTE that we do not require a dummy object, placeholder string or a key like \"input\" or \"empty\". LEAVE IT BLANK.","additionalProperties":false}}},{"type":"function","function":{"name":"task","description":"Launch a new agent to handle complex, multi-step tasks autonomously. \n\nAvailable agent types and the tools they have access to:\n- general-purpose: For complex research, code searching, and multi-step tasks (Tools: read_file, run_shell_command, glob, search_file_content, list_directory, replace, write_file, todo_read, todo_write, web_fetch, web_search)\n- plan-agent: Based on sufficient context, for planning, analysis, and outlining implementation steps without making changes (Tools: read_file, glob, save_memory, todo_read, todo_write, exit_plan_mode, list_directory, search_file_content, run_shell_command, web_search, web_fetch)\n- explore-agent: For exploring, understanding and analyzing codebases/project/files without making changes (Tools: read_file, glob, save_memory, todo_read, todo_write, exit_plan_mode, list_directory, search_file_content, run_shell_command, web_search, web_fetch, task)\n- frontend-tester: REQUIRED after any frontend file operations (write_file, replace, multi_edit on .html/.css/.js/.jsx/.ts/.tsx/.vue files). Use for testing web pages, UI components, and frontend functionality. (Tools: image_read, ask_user_question, replace, glob, list_directory, todo_write, ReadCommandOutput, todo_read, read_file, read_many_files, search_file_content, web_fetch, web_search, write_file, xml_escape, run_shell_command)\n\n\n## CRITICAL: Agent Type Naming Rules\n\n**IMPORTANT**: When using the Task tool, the subagent_type parameter MUST be EXACTLY the same as the agent type name listed above. Do not modify, abbreviate, or change the naming convention.\n\n**Valid agent type names** (copy exactly as written):\n- \"general-purpose\"\n- \"plan-agent\"\n- \"explore-agent\"\n- \"frontend-tester\"\n\n\n**Examples of CORRECT usage:**\n- For agent type \"code-reviewer\" → subagent_type: \"code-reviewer\" \n- For agent type \"general-purpose\" → subagent_type: \"general-purpose\"\n- For agent type \"frontend-developer\" → subagent_type: \"frontend-developer\"\n\n**Examples of INCORRECT usage:**\n- code-reviewer → code_review ❌\n- general-purpose → general_purpose ❌ \n- frontend-developer → frontend_developer ❌\n\n## Tool Usage Guidelines\n\nWhen to use the Task tool:\n- When you are instructed to execute custom slash commands. Use the Task tool with the slash command invocation as the entire prompt. The slash command can take arguments. For example: Task(description=\"Check the file\", prompt=\"/check-file path/to/file.py\")\n- For complex, multi-step tasks that match the agent descriptions above\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the read_file or glob tool instead of the Task tool, to find the match more quickly\n- If you are searching for a specific class definition like \"class Foo\", use the glob tool instead, to find the match more quickly\n- If you are searching for code within a specific file or set of 2-3 files, use the read_file tool instead of the Task tool, to find the match more quickly\n- Other tasks that are not related to the agent descriptions above\n\n## Usage Notes\n\n1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.\n3. Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.\n4. The agent's outputs should generally be trusted\n5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent\n6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.\n\n## Example Usage\n\n<example>\nuser: \"Please write a function that checks if a number is prime\"\nassistant: Sure let me write a function that checks if a number is prime\nassistant: First let me use the write_file tool to write a function that checks if a number is prime\nassistant: I'm going to use the write_file tool to write the following code:\n<code>\nfunction isPrime(n) {\n  if (n <= 1) return false\n  for (let i = 2; i * i <= n; i++) {\n    if (n % i === 0) return false\n  }\n  return true\n}\n</code>\n<commentary>\nSince a significant piece of code was written and the task was completed, now use the code-reviewer agent to review the code\n</commentary>\nassistant: Now let me use the code-reviewer agent to review the code\nassistant: Uses the task tool with subagent_type: \"code-reviewer\"\n</example>\n\n<example>\nuser: \"Hello\"\n<commentary>\nSince the user is greeting, use the greeting-responder agent to respond with a friendly joke\n</commentary>\nassistant: I'm going to use the task tool with subagent_type: \"greeting-responder\"\n</example>","parameters":{"type":"object","properties":{"description":{"type":"string","description":"A short (3-5 word) description of the task"},"prompt":{"type":"string","description":"The task for the agent to perform"},"subagent_type":{"type":"string","description":"The type of specialized agent to use for this task"},"useContext":{"type":"boolean","description":"Whether to include the main agent's context and prompt in the sub-agent request"},"outputFormat":{"type":"string","description":"Optional output format template for the task result. If not provided, a default format will be used."},"constraints":{"type":"string","description":"Optional constraints or limitations for the task execution. Specify any restrictions or requirements."}},"required":["description","prompt","subagent_type"],"additionalProperties":false}}},{"type":"function","function":{"name":"exit_plan_mode","description":"\nUse this tool when you are in plan mode and have finished presenting your plan and are ready to code. This will prompt the user to exit plan mode. \nIMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.\n\nEg. \n1. Initial task: \"Search for and understand the implementation of vim mode in the codebase\" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.\n2. Initial task: \"Help me implement yank mode for vim\" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.\n","parameters":{"type":"object","properties":{"plan":{"type":"string","description":"The plan you came up with, that you want to run by the user for approval. Supports markdown. The plan should be pretty concise."}},"required":["plan"],"additionalProperties":false}}},{"type":"function","function":{"name":"ask_user_question","description":"Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- Users will always be able to select \"Other\" to provide custom text input\n- Use multiSelect: true to allow multiple answers to be selected for a question\n","parameters":{"type":"object","properties":{"questions":{"type":"array","description":"Questions to ask the user (1-4 questions)","items":{"type":"object","properties":{"question":{"type":"string","description":"The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: \"Which library should we use for date formatting?\" If multiSelect is true, phrase it accordingly, e.g. \"Which features do you want to enable?\""},"header":{"type":"string","description":"Very short label displayed as a chip/tag (max 12 chars). Examples: \"Auth method\", \"Library\", \"Approach\"."},"options":{"type":"array","description":"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.","items":{"type":"object","properties":{"label":{"type":"string","description":"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice."},"description":{"type":"string","description":"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications."}},"required":["label","description"],"additionalProperties":false}},"multiSelect":{"type":"boolean","description":"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive."}},"required":["question","header","options","multiSelect"],"additionalProperties":false}},"answers":{"type":"object","description":"User answers collected by the permission component","additionalProperties":false}},"required":["questions"],"additionalProperties":false}}},{"type":"function","function":{"name":"Skill","description":"Execute a skill within the main conversation\n\n<skills_instructions>\nWhen users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.\n\nHow to invoke:\n- Use this tool with the skill name only (no arguments)\n- Examples:\n  - `skill: \"pdf\"` - invoke the pdf skill\n  - `skill: \"xlsx\"` - invoke the xlsx skill\n  - `skill: \"ms-office-suite:pdf\"` - invoke using fully qualified name\n\nImportant:\n- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action\n- NEVER just announce or mention a skill in your text response without actually calling this tool\n- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task\n- Only use skills listed in <available_skills> below\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n</skills_instructions>\n\n<available_skills>\n\n</available_skills>\n","parameters":{"type":"object","properties":{"skill":{"type":"string","description":"The skill name (no arguments). E.g., \"pdf\" or \"xlsx\""}},"required":["skill"],"additionalProperties":false}}}];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate UUID v4
 */
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Derive deterministic userId (UUID format) from apiKey
 */
function deriveUserId(apiKey) {
  const hash = crypto.createHash('sha256').update(`iflow:user:${apiKey}`).digest();
  const b = Buffer.from(hash.slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/**
 * Derive deterministic cna (24 chars, base64-like) from apiKey
 */
function deriveCna(apiKey) {
  const hash = crypto.createHash('sha256').update(`iflow:cna:${apiKey}`).digest();
  return hash.slice(0, 18).toString('base64').replace(/=+$/, '');
}

/**
 * Generate 16-char hex observation ID
 */
function generateObservationId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Generate random cache key (6-7 hex chars)
 */
function generateCacheKey() {
  return Math.random().toString(16).substring(2, 9);
}

/**
 * Generate HMAC-SHA256 signature for iFlow API
 */
function generateSignature(userAgent, sessionId, timestamp, apiKey) {
  if (!apiKey) {
    return null;
  }
  const message = `${userAgent}:${sessionId}:${timestamp}`;
  try {
    return crypto
      .createHmac('sha256', apiKey)
      .update(message)
      .digest('hex');
  } catch (error) {
    console.error('[IFlowTransformer] Failed to generate HMAC signature:', error);
    return null;
  }
}

/**
 * Generate W3C Trace Context traceparent
 * Format: 00-<32hex trace_id>-<16hex parent_id>-01
 */
function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

/**
 * Check if endpoint is Aone (requires additional headers)
 */
function isAoneEndpoint(baseUrl) {
  return baseUrl && baseUrl.toLowerCase().includes('ducky.code.alibaba-inc.com');
}

/**
 * Send HTTP POST request (fire-and-forget style)
 */
function sendTelemetry(host, path, body, contentType = 'application/json', debug = false) {
  return new Promise((resolve) => {
    const postData = typeof body === 'string' ? body : JSON.stringify(body);

    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(postData),
        'user-agent': 'node',
        'accept': '*/*',
        'accept-encoding': 'gzip, deflate, br',
      },
    };

    if (debug) {
      console.log(`[IFlowTransformer][Telemetry] POST https://${host}${path}`);
      console.log(`[IFlowTransformer][Telemetry] Body: ${postData.substring(0, 200)}...`);
    }

    const req = https.request(options, (res) => {
      if (debug) {
        console.log(`[IFlowTransformer][Telemetry] Response: ${res.statusCode}`);
      }
      resolve({ statusCode: res.statusCode });
    });

    req.on('error', (e) => {
      if (debug) {
        console.error(`[IFlowTransformer][Telemetry] Error: ${e.message}`);
      }
      resolve({ error: e.message });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Send HTTP GET request (fire-and-forget style, for startup simulation)
 */
function sendHttpGet(host, path, headers = {}, debug = false) {
  return new Promise((resolve) => {
    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: 'GET',
      headers: {
        'host': host,
        'connection': 'keep-alive',
        'accept': '*/*',
        'accept-language': '*',
        'sec-fetch-mode': 'cors',
        'user-agent': 'node',
        'accept-encoding': 'br, gzip, deflate',
        ...headers,
      },
    };

    if (debug) {
      console.log(`[IFlowTransformer][Startup] GET https://${host}${path}`);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (debug) {
          console.log(`[IFlowTransformer][Startup] Response: ${res.statusCode} (${data.length} bytes)`);
        }
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on('error', (e) => {
      if (debug) {
        console.error(`[IFlowTransformer][Startup] Error: ${e.message}`);
      }
      resolve({ error: e.message });
    });

    req.end();
  });
}

// ============================================================================
// Main Transformer Class
// ============================================================================

module.exports = class IFlowTransformer {
  static TransformerName = 'iflow';

  /**
   * Constructor
   *
   * @param {Object} options - Transformer options
   * @param {string} [options.sessionId] - Custom session ID
   * @param {string} [options.conversationId] - Custom conversation ID
   * @param {string} [options.userId] - Persistent user ID for telemetry
   * @param {string} [options.cna] - Device fingerprint
   * @param {string} [options.spmCnt] - SPM tracking coordinates
   * @param {boolean} [options.debug=false] - Enable debug logging
   * @param {boolean} [options.enableTelemetry=true] - Enable telemetry sending
   */
  constructor(options = {}) {
    this.name = 'iflow-reverse';
    this.options = options;
    this.debug = options.debug || false;
    this.enableTelemetry = options.enableTelemetry !== false;

    // Tools handling mode: 'passthrough' | 'override' | 'merge'
    // - passthrough: keep upstream tools (default)
    // - override: use official iFlow CLI tools
    // - merge: combine upstream with official tools (dedupe by name)
    this.toolsMode = options.toolsMode || 'passthrough';

    // Session and conversation IDs
    this.sessionId = options.sessionId || `session-${uuidv4()}`;
    this.conversationId = options.conversationId || uuidv4();

    // Telemetry user ID (should be persisted across restarts)
    this.userId = options.userId || uuidv4();
    this.cna = options.cna || DEFAULT_CNA;
    this.spmCnt = options.spmCnt || DEFAULT_SPM_CNT;

    // System info for APlus
    this.systemInfo = {
      platformType: 'pc',
      deviceModel: os.type() || 'Linux',
      os: os.type() || 'Linux',
      o: os.platform() || 'linux',
      nodeVersion: process.version,
      language: process.env.LANG || process.env.LANGUAGE || 'C.UTF-8',
    };

    // Startup simulation flag (queryHighQuality + ad-phrases)
    this.startupSimulated = false;

    if (this.debug) {
      console.log('[IFlowTransformer] Initialized with:');
      console.log(`  - sessionId: ${this.sessionId}`);
      console.log(`  - conversationId: ${this.conversationId}`);
      console.log(`  - userId: ${this.userId}`);
      console.log(`  - enableTelemetry: ${this.enableTelemetry}`);
      console.log(`  - toolsMode: ${this.toolsMode}`);
    }
  }

  /**
   * Build gokey string for lifecycle events
   */
  _buildGokey(params) {
    const parts = [];
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        parts.push(`${key}=${value}`);
      }
    }
    return parts.join('&');
  }

  /**
   * Send run_started lifecycle event
   */
  async sendRunStarted(context) {
    if (!this.enableTelemetry) return {};

    const {
      sessionId,
      conversationId,
      traceId,
      model,
      tool = '',
      userId,
    } = context;

    const observationId = generateObservationId();
    const sam = `iflow.cli.${conversationId}.${traceId}`;

    const gokey = this._buildGokey({
      pid: 'iflow',
      sam,
      trace_id: traceId,
      session_id: sessionId,
      conversation_id: conversationId,
      observation_id: observationId,
      model,
      tool,
      user_id: userId,
    });

    const body = {
      gmkey: 'AI',
      gokey,
    };

    const trackingInfo = {
      observationId,
      sam,
      traceId,
      sessionId,
      conversationId,
      model,
      startTime: Date.now(),
    };

    // Send asynchronously
    sendTelemetry(
      TELEMETRY_ENDPOINTS.lifecycle,
      TELEMETRY_PATHS.runStarted,
      body,
      'application/json',
      this.debug
    );

    return trackingInfo;
  }

  /**
   * Send run_finished lifecycle event
   */
  async sendRunFinished(context, trackingInfo) {
    if (!this.enableTelemetry) return;

    const {
      sessionId,
      conversationId,
      traceId,
      model,
      tool = '',
      userId,
    } = context;

    const {
      observationId: parentObservationId,
      sam,
      startTime,
    } = trackingInfo;

    const observationId = generateObservationId();
    const duration = Date.now() - startTime;

    const gokey = this._buildGokey({
      pid: 'iflow',
      sam,
      trace_id: traceId,
      session_id: sessionId,
      conversation_id: conversationId,
      observation_id: observationId,
      parent_observation_id: parentObservationId,
      duration,
      model,
      tool,
      sessionId: sessionId,
      user_id: userId,
    });

    const body = {
      gmkey: 'AI',
      gokey,
    };

    sendTelemetry(
      TELEMETRY_ENDPOINTS.lifecycle,
      TELEMETRY_PATHS.runFinished,
      body,
      'application/json',
      this.debug
    );
  }

  /**
   * Send APlus log event
   */
  async sendAplusLog(context) {
    if (!this.enableTelemetry) return;

    const { userId, cna } = context;

    const params = new URLSearchParams({
      logtype: '1',
      title: 'iFlow-CLI',
      pre: '-',
      scr: '-',
      cna: cna,
      'spm-cnt': this.spmCnt,
      aplus: '',
      pid: 'iflow',
      _user_id: userId,
      cache: generateCacheKey(),
      sidx: 'aplusSidex',
      ckx: 'aplusCkx',
      platformType: this.systemInfo.platformType,
      device_model: this.systemInfo.deviceModel,
      os: this.systemInfo.os,
      o: this.systemInfo.o,
      node_version: this.systemInfo.nodeVersion,
      language: this.systemInfo.language,
      interactive: '1',
      iFlowEnv: '',
      _g_encode: 'utf-8',
    });

    sendTelemetry(
      TELEMETRY_ENDPOINTS.aplus,
      TELEMETRY_PATHS.aplusGif,
      params.toString(),
      'text/plain;charset=UTF-8',
      this.debug
    );
  }

  /**
   * Simulate CLI startup requests (queryHighQuality + ad-phrases)
   * Called once per apiKey on first request
   */
  async _simulateStartup(apiKey) {
    if (!this.enableTelemetry) return;

    // 1. Query user privileges (platform.iflow.cn)
    const qualityPath = `${TELEMETRY_PATHS.queryHighQuality}?apiKey=${encodeURIComponent(apiKey)}`;
    sendHttpGet(
      TELEMETRY_ENDPOINTS.platform,
      qualityPath,
      {},
      this.debug
    );

    // 2. Fetch ad phrases (iflow.cn)
    sendHttpGet(
      TELEMETRY_ENDPOINTS.iflow,
      TELEMETRY_PATHS.adPhrases,
      {
        'User-Agent': IFLOW_CLI_USER_AGENT,
        'Content-Type': 'application/json',
      },
      this.debug
    );

    if (this.debug) {
      console.log('[IFlowTransformer] Startup simulation sent (queryHighQuality + ad-phrases)');
    }
  }

  /**
   * Align official default parameters for request body
   */
  _alignOfficialBodyDefaults(requestBody, stream = false) {
    const body = { ...requestBody };

    // Streaming requests carry stream=true; non-streaming omit this field
    delete body.stream;
    if (stream) {
      body.stream = true;
    }

    // Official default parameters (from packet capture 2026-03-02)
    body.temperature = body.temperature ?? 1;
    body.top_p = body.top_p ?? 0.95;
    body.max_new_tokens = body.max_new_tokens ?? 32000;

    return body;
  }

  /**
   * Replace system prompt in messages with official iFlow CLI system prompt
   * @param {Object} requestBody - The request body containing messages
   * @returns {Object} - Request body with replaced system prompt
   */
  _replaceSystemPrompt(requestBody) {
    const body = { ...requestBody };
    
    if (!body.messages || !Array.isArray(body.messages)) {
      return body;
    }

    // Find and replace system message
    body.messages = body.messages.map((msg) => {
      if (msg.role === 'system') {
        return {
          ...msg,
          content: IFLOW_SYSTEM_PROMPT,
        };
      }
      return msg;
    });

    if (this.debug) {
      console.log('[IFlowTransformer] System prompt replaced with official iFlow CLI prompt');
    }

    return body;
  }

  /**
   * Handle tools based on toolsMode configuration
   * 
   * @param {Object} requestBody - The request body
   * @returns {Object} - Request body with tools handled
   * 
   * toolsMode options:
   * - 'passthrough': Keep upstream tools unchanged (default)
   * - 'override': Replace with official iFlow CLI tools
   * - 'merge': Combine upstream with official tools (dedupe by name)
   */
  _handleTools(requestBody) {
    const body = { ...requestBody };
    const upstreamTools = body.tools || [];

    switch (this.toolsMode) {
      case 'override':
        // Use official iFlow CLI tools
        body.tools = IFLOW_TOOLS;
        if (this.debug) {
          console.log(`[IFlowTransformer] Tools mode: override (${IFLOW_TOOLS.length} official tools)`);
        }
        break;

      case 'merge':
        // Merge upstream with official tools, dedupe by name
        const officialNames = new Set(IFLOW_TOOLS.map(t => t.function?.name));
        const upstreamNames = new Set(upstreamTools.map(t => t.function?.name));
        
        // Start with upstream tools
        const mergedTools = [...upstreamTools];
        
        // Add official tools that aren't in upstream
        for (const tool of IFLOW_TOOLS) {
          if (!upstreamNames.has(tool.function?.name)) {
            mergedTools.push(tool);
          }
        }
        
        body.tools = mergedTools;
        if (this.debug) {
          const addedCount = mergedTools.length - upstreamTools.length;
          console.log(`[IFlowTransformer] Tools mode: merge (${upstreamTools.length} upstream + ${addedCount} official = ${mergedTools.length} total)`);
        }
        break;

      case 'passthrough':
      default:
        // Keep upstream tools unchanged
        if (this.debug && upstreamTools.length > 0) {
          console.log(`[IFlowTransformer] Tools mode: passthrough (${upstreamTools.length} upstream tools)`);
        }
        break;
    }

    return body;
  }

  /**
   * Configure model-specific request parameters
   * 
   * IMPORTANT: Based on packet capture analysis, thinking-related params are
   * dynamically controlled by upstream. We should NOT hardcode them here.
   * Only handle model-specific cleanup (e.g., Qwen 4B doesn't support thinking).
   */
  _configureModelRequest(requestBody, model) {
    const body = { ...requestBody };
    const modelLower = model.toLowerCase();

    // Qwen 4B models (do not support thinking)
    // Remove all thinking-related params for these models
    if (/^qwen.*4b/i.test(modelLower)) {
      delete body.thinking_mode;
      delete body.reasoning;
      delete body.chat_template_kwargs;
      delete body.thinking;
      delete body.enable_thinking;
    }

    // Note: Do NOT add default thinking params here. They are controlled by:
    // 1. Upstream request (if coming from iFlow CLI directly)
    // 2. User configuration
    // Packet capture shows GLM-5 with both enable_thinking=true AND false

    return body;
  }

  /**
   * Transform request - send telemetry, then transform with headers
   */
  async transformRequestIn(request, provider, context) {
    const timestamp = Date.now();
    // Handle both string and array api_key (for key rotation)
    const apiKeyRaw = provider.api_key || provider.apiKey;
    const apiKey = Array.isArray(apiKeyRaw)
      ? apiKeyRaw[Math.floor(Math.random() * apiKeyRaw.length)]
      : apiKeyRaw;

    // Simulate CLI startup requests on first use
    if (!this.startupSimulated) {
      this._simulateStartup(apiKey);
      this.startupSimulated = true;
    }

    // Derive deterministic userId and cna from apiKey
    const userId = deriveUserId(apiKey);
    const cna = deriveCna(apiKey);

    // Extract trace_id from existing traceparent or generate new
    const traceparent = context?.traceparent || generateTraceparent();
    const traceId = traceparent.split('-')[1] || crypto.randomBytes(16).toString('hex');

    // Build telemetry context
    const telemetryContext = {
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      traceId,
      model: request.model || 'unknown',
      userId,
      cna,
    };

    // Send telemetry before AI request
    const trackingInfo = await this.sendRunStarted(telemetryContext);
    await this.sendAplusLog(telemetryContext);

    // Store tracking info in context for response phase
    if (context) {
      context._telemetryTracking = trackingInfo;
      context._telemetryContext = telemetryContext;
      context.traceparent = traceparent;
      context.sessionId = this.sessionId;
      context.conversationId = this.conversationId;
    }

    // Align body defaults
    let body = this._alignOfficialBodyDefaults(request, request.stream || false);

    // Replace system prompt with official iFlow CLI prompt
    body = this._replaceSystemPrompt(body);

    // Handle tools based on toolsMode configuration
    body = this._handleTools(body);

    // Configure model-specific parameters
    const model = body.model || '';
    body = this._configureModelRequest(body, model);

    // Build headers
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'user-agent': IFLOW_CLI_USER_AGENT,
      'session-id': this.sessionId,
      'conversation-id': this.conversationId,
      'accept': '*/*',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
      'accept-encoding': 'br, gzip, deflate',
      'traceparent': traceparent,
    };

    // Generate HMAC signature
    const signature = generateSignature(
      IFLOW_CLI_USER_AGENT,
      this.sessionId,
      timestamp,
      apiKey
    );

    if (signature) {
      headers['x-iflow-signature'] = signature;
      headers['x-iflow-timestamp'] = String(timestamp);
    }

    // Aone-specific headers
    if (isAoneEndpoint(provider.baseUrl)) {
      headers['X-Client-Type'] = 'iflow-cli';
      headers['X-Client-Version'] = IFLOW_CLI_VERSION;
    }

    if (this.debug) {
      console.log('[IFlowTransformer] Request transformed:');
      console.log(`  - Model: ${model}`);
      console.log(`  - Headers: ${Object.keys(headers).length}`);
      console.log(`  - Telemetry: sent run_started + APlus log`);
    }

    return {
      body,
      config: { headers },
    };
  }

  /**
   * Transform response - send run_finished after AI request completes
   */
  async transformResponseOut(response, context) {
    const trackingInfo = context?._telemetryTracking;
    const telemetryContext = context?._telemetryContext;

    if (trackingInfo && telemetryContext) {
      await this.sendRunFinished(telemetryContext, trackingInfo);

      if (this.debug) {
        console.log('[IFlowTransformer] Response: sent run_finished telemetry');
      }
    }

    return response;
  }

  /**
   * Reset session and conversation IDs
   */
  resetSession() {
    this.sessionId = `session-${uuidv4()}`;
    this.conversationId = uuidv4();

    if (this.debug) {
      console.log('[IFlowTransformer] Session reset:');
      console.log(`  - sessionId: ${this.sessionId}`);
      console.log(`  - conversationId: ${this.conversationId}`);
    }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      userId: this.userId,
      cna: this.cna,
      spmCnt: this.spmCnt,
      enableTelemetry: this.enableTelemetry,
    };
  }

  /**
   * Set user ID (for persistence)
   */
  setUserId(userId) {
    this.userId = userId;
    if (this.debug) {
      console.log(`[IFlowTransformer] Updated userId: ${userId}`);
    }
  }
};
