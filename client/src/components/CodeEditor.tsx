import Editor from "@monaco-editor/react"
import { useEffect, useRef } from "react"
import type { editor } from "monaco-editor"

type Props = {
  value: string
  language: string
  onChange: (value: string) => void
  onCursorMove: (line: number, column: number) => void
  remoteCursor: { line: number; column: number } | null
}

export default function CodeEditor({ value, language, onChange, onCursorMove, remoteCursor }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<string[]>([])

  const handleMount = (instance: editor.IStandaloneCodeEditor) => {
    editorRef.current = instance
    const model = instance.getModel()
    if (model && model.getValue() !== value) model.setValue(value)
    instance.onDidChangeCursorPosition(({ position }) => onCursorMove(position.lineNumber, position.column))
  }

  useEffect(() => {
    const instance = editorRef.current
    const model = instance?.getModel()
    if (!instance || !model || model.getValue() === value) return
    const selection = instance.getSelection()
    const clampPosition = (lineNumber: number, column: number) => {
      const line = Math.min(Math.max(lineNumber, 1), model.getLineCount())
      return { lineNumber: line, column: Math.min(Math.max(column, 1), model.getLineMaxColumn(line)) }
    }
    const start = selection ? clampPosition(selection.startLineNumber, selection.startColumn) : null
    const end = selection ? clampPosition(selection.endLineNumber, selection.endColumn) : null
    model.setValue(value)
    if (start && end) instance.setSelection({
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    })
  }, [value])

  useEffect(() => {
    const instance = editorRef.current
    if (!instance) return
    if (!remoteCursor) {
      decorationsRef.current = instance.deltaDecorations(decorationsRef.current, [])
      return
    }
    const model = instance.getModel()
    if (!model) return
    const line = Math.min(Math.max(remoteCursor.line, 1), model.getLineCount())
    const column = Math.min(Math.max(remoteCursor.column, 1), model.getLineMaxColumn(line))
    decorationsRef.current = instance.deltaDecorations(decorationsRef.current, [{
      range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
      options: { beforeContentClassName: "remote-cursor", stickiness: 1 },
    }])
  }, [remoteCursor])

  return <Editor height="100%" language={language} defaultValue={value} onChange={(next) => onChange(next ?? "")} onMount={handleMount} theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 14, automaticLayout: true }} />
}
