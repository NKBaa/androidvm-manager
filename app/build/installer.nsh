; 自定义 NSIS 脚本（由 package.json 的 nsis.include 引入）
;
; 目的：卸载时把虚拟机数据一起删掉。
;
; 为什么用 customUnInstall 而不是 customRemoveFiles：
;   customRemoveFiles 会**替换**掉 electron-builder 默认的删除逻辑，
;   其中包含覆盖安装（更新）时把 $INSTDIR 原子改名再恢复的保护。
;   一旦替换，覆盖安装就可能把用户数据删掉。
;   customUnInstall 是在默认流程**之后**执行的钩子，不动原有逻辑，安全得多。
;
; 数据目录的两种情况：
;   1) 默认在 $INSTDIR\AndroidVM —— 默认的 RMDir /r $INSTDIR 已经删掉了
;   2) 安装目录不可写时程序会退到 %LOCALAPPDATA%\AndroidVM —— 这里补删
;   程序启动时会把真实路径写进 HKLM\Software\AndroidVM\DataRoot，这里读出来用。
;   对第 1 种情况，RMDir 作用在已删除的目录上是空操作，不会出错。

!macro customUnInstall
  ; 覆盖安装（更新）时绝不能删数据，默认流程会把 $INSTDIR 恢复回去
  ${ifNot} ${isUpdated}
    ReadRegStr $R8 HKLM "Software\AndroidVM" "DataRoot"
    ${if} $R8 != ""
      ${if} ${FileExists} "$R8\*.*"
        DetailPrint "正在删除虚拟机数据：$R8"
        RMDir /r "$R8"
      ${endif}
    ${endif}
    DeleteRegKey HKLM "Software\AndroidVM"
  ${endif}
!macroend
