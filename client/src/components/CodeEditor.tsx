import Editor from "@monaco-editor/react"
import { MonacoBinding } from "y-monaco"
import type * as Y from "yjs"
import { useEffect, useRef, useState } from "react"
import type { editor } from "monaco-editor"

type Props = {
  doc: Y.Doc
  language: string
  onCursorMove: (line: number, column: number) => void
  remoteCursors: { userId: string; username: string; color: string; line: number; column: number }[]
}

export default function CodeEditor({ doc, language, onCursorMove, remoteCursors }: Props) {
  const [editorInstance, setEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<string[]>([])

  const handleMount = (instance: editor.IStandaloneCodeEditor) => {
    setEditorInstance(instance)
    instance.onDidChangeCursorPosition(({ position }) => onCursorMove(position.lineNumber, position.column))
  }

  useEffect(() => {
    const model = editorInstance?.getModel()
    if (!editorInstance || !model) return
    const binding = new MonacoBinding(doc.getText("code"), model, new Set([editorInstance]))
    return () => binding.destroy()
  }, [doc, editorInstance])

  useEffect(() => {
    if (!editorInstance) return
    const model = editorInstance.getModel()
    if (!model) return
    const decorations = remoteCursors.map((cursor) => {
      const line = Math.min(Math.max(cursor.line, 1), model.getLineCount())
      const column = Math.min(Math.max(cursor.column, 1), model.getLineMaxColumn(line))
      const classId = cursor.userId.replace(/[^a-z0-9_-]/gi, "_")
      return {
        range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
        options: {
          beforeContentClassName: `remote-cursor-${classId}`,
          after: { content: cursor.username, inlineClassName: `remote-cursor-label-${classId}` },
          stickiness: 1,
        },
      }
    })
    decorationsRef.current = editorInstance.deltaDecorations(decorationsRef.current, decorations)
  }, [remoteCursors, editorInstance])

  return <>
    <style>{remoteCursors.map(({ userId, color }) => {
      const classId = userId.replace(/[^a-z0-9_-]/gi, "_")
      return `.remote-cursor-${classId}::before{content:"";margin-left:-1px;border-left:2px solid ${color}}.remote-cursor-label-${classId}{background:${color};color:#101214;border-radius:2px;margin-left:3px;padding:1px 4px;font-size:11px;font-weight:600}`
    }).join("\n")}</style>
    <Editor height="100%" language={language} defaultValue={doc.getText("code").toString()} onMount={handleMount} theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 14, automaticLayout: true }} />
  </>
}
