import Editor from "@monaco-editor/react"
import { useEffect,useRef } from "react"
import type { editor } from "monaco-editor"

type Props={
  value:string
  language:string
  onChange:(val:string)=>void
  onCursorMove:(line:number,column:number)=>void
  remoteCursor:{line:number,column:number}|null
}

export default function CodeEditor({
  value,
  language,
  onChange,
  onCursorMove,
  remoteCursor
}:Props){

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  const handleMount=(editorInstance:editor.IStandaloneCodeEditor)=>{

    editorRef.current=editorInstance

    editorInstance.onDidChangeCursorPosition((e)=>{

      onCursorMove(
        e.position.lineNumber,
        e.position.column
      )
    })
  }

  useEffect(()=>{

    if(!remoteCursor)return

    const editor = editorRef.current

    if(!editor)return

    editor.deltaDecorations([],[
      {
        range:{
          startLineNumber:remoteCursor.line,
          startColumn:remoteCursor.column,
          endLineNumber:remoteCursor.line,
          endColumn:remoteCursor.column+1
        },

        options:{
          inlineClassName:"remote-cursor"
        }
      }
    ])

  },[remoteCursor])

  return(
    <Editor
      height="100%"
      language={language}
      value={value}

      onChange={(v)=>{
        onChange(v || "")
      }}

      onMount={handleMount}

      theme="vs-dark"
    />
  )
}