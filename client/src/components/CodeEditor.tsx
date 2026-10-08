import Editor from "@monaco-editor/react"
import { MonacoBinding } from "y-monaco"
import type * as Y from "yjs"
import { useEffect, useRef } from "react"
import type { editor } from "monaco-editor"

type Props = {
  doc: Y.Doc
  language: string
  onCursorMove: (line: number, column: number) => void
  remoteCursor: { line: number; column: number } | null
}

export default function CodeEditor({ doc, language, onCursorMove, remoteCursor }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<string[]>([])

  const handleMount = (instance: editor.IStandaloneCodeEditor) => {
    editorRef.current = instance
    instance.onDidChangeCursorPosition(({ position }) => onCursorMove(position.lineNumber, position.column))
  }

  useEffect(() => {
    const instance = editorRef.current
    const model = instance?.getModel()
    if (!instance || !model) return
    const binding = new MonacoBinding(doc.getText("code"), model, new Set([instance]))
    return () => binding.destroy()
  }, [doc])

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

  return <Editor height="100%" language={language} defaultValue="" onMount={handleMount} theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 14, automaticLayout: true }} />
}
