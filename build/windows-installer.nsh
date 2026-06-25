!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
Var AhtDesktopShortcutCheckbox
Var AhtCreateDesktopShortcut

!macro customInit
  StrCpy $AhtCreateDesktopShortcut ${BST_CHECKED}
!macroend

!macro customPageAfterChangeDir
  Page custom AhtShortcutOptionsPageCreate AhtShortcutOptionsPageLeave
!macroend

Function AhtShortcutOptionsPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0u 0u 100% 24u "Choose which shortcuts to create for AHT Launcher."
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
!endif
