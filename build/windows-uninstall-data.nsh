!include FileFunc.nsh
!include MUI2.nsh

Var AhtDataRoot
Var AhtRemoveData
Var AhtRemoveDataCheckbox
Var AhtDataSafe
Var AhtDataRemovalFailed
Var AhtDataIsUpdate
Var AhtDataPageInitialized

!macro customUnInit
  ; Silent uninstall is also used during upgrades/reinstalls. Only an explicit
  ; selection on the interactive page can authorize removal of game data.
  StrCpy $AhtRemoveData ${BST_UNCHECKED}
  StrCpy $AhtDataPageInitialized 0
  StrCpy $AhtDataIsUpdate 0
  ${If} ${isUpdated}
    StrCpy $AhtDataIsUpdate 1
  ${EndIf}
  ${GetRoot} "$WINDIR" $AhtDataRoot
  StrCpy $AhtDataRoot "$AhtDataRoot\AHT"
!macroend

!macro customUnWelcomePage
  UninstPage custom un.AhtDataPageCreate un.AhtDataPageLeave
!macroend

Function un.AhtCheckDataRoot
  StrCpy $AhtDataSafe 0
  Push $0
  Push $1
  Push $2
  ; Refuse redirected roots or ancestors. Never follow a junction to a different
  ; drive/folder, including when checking the ownership marker.
  StrCpy $0 $AhtDataRoot
  aht_check_ancestor:
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
    IntCmp $1 -1 aht_root_done
    IntOp $2 $1 & 0x400
    IntCmp $2 0 0 aht_root_done aht_root_done
    IntOp $2 $1 & 0x10
    IntCmp $2 0 aht_root_done
    ${GetParent} "$0" $1
    StrCmp $1 "" aht_check_marker
    StrCmp $1 $0 aht_check_marker
    StrCpy $0 $1
    Goto aht_check_ancestor
  aht_check_marker:
    StrCpy $0 "$AhtDataRoot\A Hard Time"
    Call un.AhtCheckInstanceMarker
    StrCmp $AhtDataSafe 1 aht_root_done
    StrCpy $0 "$AhtDataRoot\A Hard Time PTB"
    Call un.AhtCheckInstanceMarker
  aht_root_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $0 is one of the two fixed child paths above, never a config/registry value.
Function un.AhtCheckInstanceMarker
  Push $0
  Push $1
  Push $2
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  IntCmp $1 -1 aht_marker_done
  IntOp $2 $1 & 0x410
  IntCmp $2 0x10 0 aht_marker_done aht_marker_done
  StrCpy $0 "$0\.aht-launcher"
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  IntCmp $1 -1 aht_marker_done
  IntOp $2 $1 & 0x410
  IntCmp $2 0x10 0 aht_marker_done aht_marker_done
  StrCpy $0 "$0\installed.json"
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  IntCmp $1 -1 aht_marker_done
  IntOp $2 $1 & 0x410
  IntCmp $2 0 0 aht_marker_done aht_marker_done
  StrCpy $AhtDataSafe 1
  aht_marker_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function un.AhtDataPageCreate
  ${If} ${Silent}
  ${OrIf} $AhtDataIsUpdate == 1
    Abort
  ${EndIf}
  Call un.AhtCheckDataRoot
  !insertmacro MUI_HEADER_TEXT "Uninstall AHT Launcher" "Choose whether to keep your modpacks and game data."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0u 0u 100% 24u "AHT Launcher will be removed from this computer. Close Minecraft before continuing."
  Pop $0
  ${NSD_CreateCheckbox} 0u 30u 100% 16u "Remove AHT modpacks and game data"
  Pop $AhtRemoveDataCheckbox
  ${If} $AhtDataSafe == 1
    ${If} $AhtDataPageInitialized == 0
      StrCpy $AhtRemoveData ${BST_CHECKED}
    ${EndIf}
    ${If} $AhtRemoveData == ${BST_CHECKED}
      ${NSD_Check} $AhtRemoveDataCheckbox
    ${EndIf}
  ${Else}
    StrCpy $AhtRemoveData ${BST_UNCHECKED}
    EnableWindow $AhtRemoveDataCheckbox 0
  ${EndIf}
  StrCpy $AhtDataPageInitialized 1
  ${NSD_CreateLabel} 10u 53u 95% 34u "Permanently deletes downloaded modpacks, saved worlds, screenshots, settings, and all other files in the folder below. Uncheck this option to keep your files."
  Pop $0
  ${NSD_CreateLabel} 10u 90u 95% 25u "Folder: $AhtDataRoot"
  Pop $0
  ${NSD_CreateLabel} 10u 120u 95% 26u "Custom modpack locations outside this folder are kept. Removal is available only when an AHT installation is detected."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function un.AhtDataPageLeave
  ${NSD_GetState} $AhtRemoveDataCheckbox $AhtRemoveData
FunctionEnd

; Recursion visits ordinary directories only. Reparse points are removed as
; links, without enumerating their targets. No RMDir /r or shell commands.
Function un.AhtRemoveDataTree
  Exch $0
  Push $1
  Push $2
  Push $3
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  IntCmp $1 -1 aht_remove_failed
  IntOp $2 $1 & 0x400
  IntCmp $2 0 aht_remove_regular
  IntOp $2 $1 & 0x10
  IntCmp $2 0 aht_remove_file aht_remove_directory aht_remove_directory
  aht_remove_regular:
    IntOp $2 $1 & 0x10
    IntCmp $2 0 aht_remove_file
    FindFirst $1 $2 "$0\*"
    aht_remove_next:
      StrCmp $2 "" aht_remove_finished
      StrCmp $2 "." aht_remove_continue
      StrCmp $2 ".." aht_remove_continue
      Push "$0\$2"
      Call un.AhtRemoveDataTree
      aht_remove_continue:
        FindNext $1 $2
        Goto aht_remove_next
    aht_remove_finished:
      FindClose $1
  aht_remove_directory:
    ClearErrors
    RMDir "$0"
    IfErrors aht_remove_failed aht_remove_done
  aht_remove_file:
    ClearErrors
    Delete "$0"
    IfErrors aht_remove_failed aht_remove_done
  aht_remove_failed:
    StrCpy $AhtDataRemovalFailed 1
  aht_remove_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro customUnInstall
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
  ${AndIf} $AhtRemoveData == ${BST_CHECKED}
    Call un.AhtCheckDataRoot
    ${If} $AhtDataSafe == 1
      SetOutPath "$TEMP"
      StrCpy $AhtDataRemovalFailed 0
      Push $AhtDataRoot
      Call un.AhtRemoveDataTree
      ${If} $AhtDataRemovalFailed == 1
        MessageBox MB_OK|MB_ICONINFORMATION "AHT Launcher will be uninstalled, but some game data could not be removed. Close Minecraft and remove the remaining files in $AhtDataRoot when they are no longer in use."
      ${EndIf}
    ${Else}
      MessageBox MB_OK|MB_ICONINFORMATION "The AHT data folder could not be verified. Your game data has been kept."
    ${EndIf}
  ${EndIf}
!macroend
