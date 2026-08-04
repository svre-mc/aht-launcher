!include nsDialogs.nsh
!include LogicLib.nsh
!include StrFunc.nsh

!ifndef BUILD_UNINSTALLER
${StrStr}
${StrTok}
Var AhtDesktopShortcutCheckbox
Var AhtCreateDesktopShortcut
Var AhtManagedJavaCheckbox
Var AhtInstallManagedJava
Var AhtJava8Found

Function AhtProbeJava8Executable
  ${If} $AhtJava8Found == "1"
    Return
  ${EndIf}
  IfFileExists "$9" 0 aht_probe_java_done
  nsExec::ExecToStack /TIMEOUT=8000 '"$9" -XshowSettings:properties -version'
  Pop $0
  Pop $1
  ${If} $0 == "0"
    ${StrStr} $2 "$1" "java.version = 1.8"
    ${If} $2 == ""
      ${StrStr} $2 "$1" "java.specification.version = 1.8"
    ${EndIf}
    ${StrStr} $3 "$1" "sun.arch.data.model = 64"
    ${If} $2 != ""
    ${AndIf} $3 != ""
      StrCpy $AhtJava8Found "1"
    ${EndIf}
  ${EndIf}
  aht_probe_java_done:
FunctionEnd

Function AhtProbeJava8Home
  ${If} $AhtJava8Found == "1"
    Return
  ${EndIf}
  ${If} $8 == ""
    Return
  ${EndIf}
  StrCpy $9 "$8\bin\java.exe"
  Call AhtProbeJava8Executable
  ${If} $AhtJava8Found != "1"
    StrCpy $9 "$8\jre\bin\java.exe"
    Call AhtProbeJava8Executable
  ${EndIf}
FunctionEnd

Function AhtProbeJava8Path
  ReadEnvStr $6 "PATH"
  StrCpy $4 0
  aht_java_path_loop:
    ${If} $AhtJava8Found == "1"
      Return
    ${EndIf}
    ${StrTok} $8 "$6" ";" "$4" "1"
    StrCmp $8 "" aht_java_path_done
    StrCpy $0 "$8" 1
    ${If} $0 == "$\""
      StrCpy $8 "$8" "" 1
    ${EndIf}
    StrCpy $0 "$8" 1 -1
    ${If} $0 == "$\""
      StrCpy $8 "$8" -1
    ${EndIf}
    StrCpy $9 "$8\java.exe"
    Call AhtProbeJava8Executable
    IntOp $4 $4 + 1
    Goto aht_java_path_loop
  aht_java_path_done:
FunctionEnd

Function AhtProbeJavaSoftKey
  ReadRegStr $0 HKLM "$7" "CurrentVersion"
  ${If} $0 != ""
    ReadRegStr $1 HKLM "$7\$0" "JavaHome"
    ${If} $1 != ""
      StrCpy $9 "$1\bin\java.exe"
      Call AhtProbeJava8Executable
    ${EndIf}
  ${EndIf}

  StrCpy $4 0
  aht_java_soft_loop:
    ${If} $AhtJava8Found == "1"
      Return
    ${EndIf}
    ClearErrors
    EnumRegKey $0 HKLM "$7" $4
    IfErrors aht_java_soft_done
    StrCmp $0 "" aht_java_soft_done
    StrCpy $1 $0 3
    StrCpy $2 $0 1
    ${If} $1 == "1.8"
    ${OrIf} $2 == "8"
      ReadRegStr $3 HKLM "$7\$0" "JavaHome"
      ${If} $3 != ""
        StrCpy $9 "$3\bin\java.exe"
        Call AhtProbeJava8Executable
      ${EndIf}
    ${EndIf}
    IntOp $4 $4 + 1
    Goto aht_java_soft_loop
  aht_java_soft_done:
FunctionEnd

Function AhtProbeAdoptiumKey
  StrCpy $4 0
  aht_adoptium_loop:
    ${If} $AhtJava8Found == "1"
      Return
    ${EndIf}
    ClearErrors
    EnumRegKey $0 HKLM "$7" $4
    IfErrors aht_adoptium_done
    StrCmp $0 "" aht_adoptium_done
    StrCpy $1 $0 1
    ${If} $1 == "8"
      ReadRegStr $2 HKLM "$7\$0\hotspot\MSI" "Path"
      ${If} $2 == ""
        ReadRegStr $2 HKLM "$7\$0\hotspot\MSI" "JavaHome"
      ${EndIf}
      ${If} $2 != ""
        StrCpy $9 "$2\bin\java.exe"
        Call AhtProbeJava8Executable
      ${EndIf}
    ${EndIf}
    IntOp $4 $4 + 1
    Goto aht_adoptium_loop
  aht_adoptium_done:
FunctionEnd

Function AhtProbeJava8DirectoryPattern
  ClearErrors
  FindFirst $4 $5 "$7\$8"
  IfErrors aht_java_dir_no_handle
  aht_java_dir_loop:
    StrCmp $5 "" aht_java_dir_done
    StrCpy $9 "$7\$5\bin\java.exe"
    Call AhtProbeJava8Executable
    ${If} $AhtJava8Found == "1"
      Goto aht_java_dir_done
    ${EndIf}
    ClearErrors
    FindNext $4 $5
    IfErrors aht_java_dir_done
    Goto aht_java_dir_loop
  aht_java_dir_done:
  FindClose $4
  aht_java_dir_no_handle:
FunctionEnd

Function AhtDetectJava8
  StrCpy $AhtJava8Found "0"

  ; Match the launcher's supported explicit Java homes before scanning vendors.
  ReadEnvStr $8 "AHT_JAVA_HOME"
  Call AhtProbeJava8Home
  ReadEnvStr $8 "JAVA8_HOME"
  Call AhtProbeJava8Home
  ReadEnvStr $8 "JDK8_HOME"
  Call AhtProbeJava8Home
  ReadEnvStr $8 "JRE8_HOME"
  Call AhtProbeJava8Home
  ReadEnvStr $8 "JDK_HOME"
  Call AhtProbeJava8Home
  ReadEnvStr $8 "JAVA_HOME"
  Call AhtProbeJava8Home
  ReadEnvStr $8 "JRE_HOME"
  Call AhtProbeJava8Home

  ; Probe every PATH entry so a newer Java before Java 8 does not hide Java 8.
  Call AhtProbeJava8Path

  SetRegView 64
  StrCpy $7 "SOFTWARE\JavaSoft\Java Development Kit"
  Call AhtProbeJavaSoftKey
  StrCpy $7 "SOFTWARE\JavaSoft\Java Runtime Environment"
  Call AhtProbeJavaSoftKey
  StrCpy $7 "SOFTWARE\Eclipse Adoptium\JDK"
  Call AhtProbeAdoptiumKey
  StrCpy $7 "SOFTWARE\Eclipse Adoptium\JRE"
  Call AhtProbeAdoptiumKey

  StrCpy $7 "$PROGRAMFILES64\Eclipse Adoptium"
  StrCpy $8 "jdk-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $8 "jre-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$PROGRAMFILES64\Java"
  StrCpy $8 "jdk1.8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $8 "jre1.8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$PROGRAMFILES64\Microsoft"
  StrCpy $8 "jdk-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $8 "jre-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$PROGRAMFILES64\Zulu"
  StrCpy $8 "zulu-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $8 "zulu8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$PROGRAMFILES64\BellSoft"
  StrCpy $8 "LibericaJDK-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $8 "LibericaJRE-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$LOCALAPPDATA\Programs\Eclipse Adoptium"
  StrCpy $8 "jdk-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $8 "jre-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$LOCALAPPDATA\Programs\Microsoft"
  StrCpy $8 "jdk-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$LOCALAPPDATA\Programs\Zulu"
  StrCpy $8 "zulu-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $8 "zulu8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$LOCALAPPDATA\Programs\BellSoft"
  StrCpy $8 "LibericaJDK-8*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $8 "LibericaJRE-8*"
  Call AhtProbeJava8DirectoryPattern

  ; IntelliJ and other per-user JDK managers commonly install one level here.
  StrCpy $7 "$PROFILE\.jdks"
  StrCpy $8 "*"
  Call AhtProbeJava8DirectoryPattern

  ; Probe Scoop's version/current directories for the Java 8 packages accepted by Play.
  ReadEnvStr $6 "SCOOP"
  ${If} $6 == ""
    StrCpy $6 "$PROFILE\scoop"
  ${EndIf}
  StrCpy $7 "$6\apps\temurin8"
  StrCpy $8 "*"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$6\apps\temurin8-jdk"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$6\apps\temurin8-jre"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$6\apps\adoptium8"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$6\apps\jdk8"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$6\apps\jre8"
  Call AhtProbeJava8DirectoryPattern
  StrCpy $7 "$6\apps\zulu8"
  Call AhtProbeJava8DirectoryPattern
FunctionEnd

!macro customInit
  StrCpy $AhtCreateDesktopShortcut ${BST_CHECKED}
  Call AhtDetectJava8
  ${If} $AhtJava8Found == "1"
    StrCpy $AhtInstallManagedJava ${BST_UNCHECKED}
  ${Else}
    StrCpy $AhtInstallManagedJava ${BST_CHECKED}
  ${EndIf}
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

  ${NSD_CreateLabel} 0u 0u 100% 24u "Choose optional setup features for AHT Launcher."
  Pop $0

  ${NSD_CreateCheckbox} 0u 36u 100% 12u "Create a desktop shortcut"
  Pop $AhtDesktopShortcutCheckbox

  ${If} $AhtCreateDesktopShortcut == ${BST_CHECKED}
    ${NSD_Check} $AhtDesktopShortcutCheckbox
  ${EndIf}

  ${NSD_CreateCheckbox} 0u 60u 100% 12u "Install Adoptium Java 8 if needed"
  Pop $AhtManagedJavaCheckbox

  ${If} $AhtInstallManagedJava == ${BST_CHECKED}
    ${NSD_Check} $AhtManagedJavaCheckbox
  ${EndIf}

  ${NSD_CreateLabel} 0u 78u 100% 20u "Automatically checked when a usable 64-bit Java 8 runtime is not detected."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function AhtShortcutOptionsPageLeave
  ${NSD_GetState} $AhtDesktopShortcutCheckbox $AhtCreateDesktopShortcut
  ${NSD_GetState} $AhtManagedJavaCheckbox $AhtInstallManagedJava
FunctionEnd

!macro customInstall
  CreateDirectory "$APPDATA\aht-launcher"
  FileOpen $0 "$APPDATA\aht-launcher\installer-java8-selection.json" w
  ${If} $AhtInstallManagedJava == ${BST_CHECKED}
    FileWrite $0 '{$\"schemaVersion$\":1,$\"allowManagedJava8$\":true}$\r$\n'
  ${Else}
    FileWrite $0 '{$\"schemaVersion$\":1,$\"allowManagedJava8$\":false}$\r$\n'
  ${EndIf}
  FileClose $0

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
!macro customUnInstall
!macroend
!endif
