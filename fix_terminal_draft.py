import re

with open('src/terminal-draft.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Add imports at the top
if 'import type { SlashPickerController }' not in content:
    content = content.replace(
        "import type { ReadStream, WriteStream } from 'node:tty';\n",
        "import type { ReadStream, WriteStream } from 'node:tty';\nimport type { SlashCommandEntry } from './slash-command.js';\nimport { filterSlashCommands, slashCommandEntries } from './slash-command.js';\nimport type { SlashPickerController } from './slash-picker.js';\n"
    )

# Fix readOpenTuiDraft signature
content = content.replace(
    "async function readOpenTuiDraft(input: ReadStream, output: WriteStream, prompt: string, onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null): Promise<string | null> {",
    "async function readOpenTuiDraft(input: ReadStream, output: WriteStream, prompt: string, onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null, slashPicker?: SlashPickerController): Promise<string | null> {"
)

# Fix readLegacyTerminalDraft signature
content = content.replace(
    "async function readLegacyTerminalDraft(input: ReadStream, output: WriteStream, prompt = 'wentian> ', onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null): Promise<string | null> {",
    "async function readLegacyTerminalDraft(input: ReadStream, output: WriteStream, prompt = 'wentian> ', onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null, slashPicker?: SlashPickerController): Promise<string | null> {"
)

# Fix readTerminalDraft signature and calls
content = content.replace(
    "export async function readTerminalDraft(input: ReadStream, output: WriteStream, prompt = 'wentian> ', onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null): Promise<string | null> {",
    "export async function readTerminalDraft(input: ReadStream, output: WriteStream, prompt = 'wentian> ', onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null, slashPicker?: SlashPickerController): Promise<string | null> {"
)
content = content.replace(
    "if (process.platform === 'win32' && process.env.WT_SESSION) return readOpenTuiDraft(input, output, prompt, onPasteImage, history, onSlashHint, onHistoryLookup);",
    "if (process.platform === 'win32' && process.env.WT_SESSION) return readOpenTuiDraft(input, output, prompt, onPasteImage, history, onSlashHint, onHistoryLookup, slashPicker);"
)
content = content.replace(
    "return readLegacyTerminalDraft(input, output, prompt, onPasteImage, history, onSlashHint, onHistoryLookup);",
    "return readLegacyTerminalDraft(input, output, prompt, onPasteImage, history, onSlashHint, onHistoryLookup, slashPicker);"
)

with open('src/terminal-draft.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print('terminal-draft.ts updated')
