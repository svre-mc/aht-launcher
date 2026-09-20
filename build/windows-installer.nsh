!ifdef BUILD_UNINSTALLER
; Keep the small standalone uninstaller and its plugin data directly inspectable.
; The much larger application payload remains in the normal compressed ZIP.
SetCompress off
!endif
!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
; Retain the exact generated (and, when configured, signed) uninstaller for the
; ZIP updater. electron-builder deletes its temporary copy after this compile.
!ifdef UNINSTALLER_OUT_FILE
  !system 'node "${BUILD_RESOURCES_DIR}\windows-update-uninstaller.cjs" "${UNINSTALLER_OUT_FILE}"' = 0
!endif
Var AhtDesktopShortcutCheckbox
Var AhtCreateDesktopShortcut

!macro customInit
  StrCpy $AhtCreateDesktopShortcut ${BST_CHECKED}
!macroend

!macro customPageAfterChangeDir
  Page custom AhtShortcutOptionsPageCreate AhtShortcutOptionsPageLeave
!macroend

; Function bodies must follow electron-builder's plugin-directory declarations.
!macro customHeader
Function AhtShortcutOptionsPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0u 0u 100% 24u "AHT includes Eclipse Temurin 8 (64-bit). No separate Java installation is needed."
  Pop $0
  ${NSD_CreateCheckbox} 0u 36u 100% 12u "Create a desktop shortcut"
  Pop $AhtDesktopShortcutCheckbox
  ${If} $AhtCreateDesktopShortcut == ${BST_CHECKED}
    ${NSD_Check} $AhtDesktopShortcutCheckbox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function AhtShortcutOptionsPageLeave
  ${NSD_GetState} $AhtDesktopShortcutCheckbox $AhtCreateDesktopShortcut
FunctionEnd
!macroend

!macro customInstall
  ${If} $AhtCreateDesktopShortcut != ${BST_CHECKED}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"

    ${If} "$oldDesktopLink" != "$newDesktopLink"
      WinShell::UninstShortcut "$oldDesktopLink"
      Delete "$oldDesktopLink"
    ${EndIf}

    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend
!else
!include "${BUILD_RESOURCES_DIR}\windows-uninstall-data.nsh"
!endif
