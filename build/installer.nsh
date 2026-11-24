; Custom NSIS hooks for the Featured App installer (electron-builder.yml → nsis.include).
;
; customInit: during an auto-update the app starts this installer and THEN
; quits, so the installer can start while the old process (and Electron's GPU /
; renderer helpers) still hold files in the install folder. The previous
; uninstaller then fails with "Failed to uninstall old application files: 2"
; and the update never lands. So: end anything still running under the app's
; executable name, wait for it to go (at most ~6 s), then give Windows a moment
; to release the file handles.
!macro customInit
  StrCpy $R9 0

  featured_kill_loop:
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R8
    ${If} $R8 != 0
      Goto featured_kill_done
    ${EndIf}

    nsProcess::_KillProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R8
    Sleep 300

    IntOp $R9 $R9 + 1
    ${If} $R9 < 20
      Goto featured_kill_loop
    ${EndIf}

  featured_kill_done:
  Sleep 700
!macroend

; The stock "uninstall the previous version" step aborts the whole update when
; the old uninstaller returns non-zero (usually a briefly locked file). For a
; one-click per-user install the new files overwrite the old ones anyway, so
; note the code and carry on.
!macro customUnInstallCheckCurrentUser
  IfErrors featured_uninstall_unlaunchable 0

  ${if} $R0 != 0
    DetailPrint "Previous uninstaller exited with $R0; continuing - the new files replace the old ones."
  ${endif}
  Return

  featured_uninstall_unlaunchable:
    DetailPrint "Could not launch the previous uninstaller; continuing with the install."
!macroend

!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "Previous uninstaller exited with $R0; continuing - the new files replace the old ones."
  ${endif}
!macroend
