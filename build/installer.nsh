; PlayOut's additions to electron-builder's NSIS scripts (electron-builder.yml: nsis.include).

; The uninstaller (run on uninstall, and by the installer on every update) removes everything in the install folder
; except the folders of what PlayOut downloaded there: Emulators (the emulators it set up, docs/emulator-setup.md),
; Recompilations (installed recompilations, src/main/recomp/state.ts) and VR Mods (downloaded VR mods,
; src/shared/vr-mods.ts VR_MODS_FOLDER) and Upgrades (the Upgrade menu's tools and files, src/shared/upgrades.ts
; UPGRADES_FOLDER). Before 0.1.149 only Emulators was kept, so every update deleted the others.
; Emulation is kept too: PlayOut 0.1.81 used that name for the emulators (the app moves it to Emulators at its next
; launch), and an Emulation folder (saves, BIOS files, ROMs, the favourites list) an older setup put beside PlayOut.exe
; must outlive uninstalls and updates until the user moves it (PlayOut offers to move it to Documents\Emulation; a
; new Emulation folder can no longer be put in the install folder: src/main/emulation/emulation-location.ts).
; PlayOut's data folder (%APPDATA%\playout, library.json with the favourites) is never removed: electron-builder.yml
; does not set deleteAppDataOnUninstall.
;
; On an update it keeps electron-builder's all-or-nothing behaviour (uninstaller.nsh, used when this macro is not
; defined): every file outside those folders is first moved into $PLUGINSDIR\old-install with the stock un.atomicRMDir,
; file by file (a folder cannot be renamed onto another drive, and %TEMP% may be on one), and if any file is busy
; the moved ones go back with un.restoreFiles and the update aborts, rather than leaving a half-deleted install.
!macro customRemoveFiles
  ; Move out of $INSTDIR so it is not locked.
  SetOutPath $TEMP
  Push $R0
  Push $R1
  Push $R2

  ${If} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    ; $R2: "" while every move succeeded, else the path that could not be moved.
    StrCpy $R2 ""
    ClearErrors
    FindFirst $R0 $R1 "$INSTDIR\*.*"
    ${DoUntil} ${Errors}
      ${If} $R1 != "."
      ${AndIf} $R1 != ".."
      ${AndIf} $R1 != "Emulators"
      ${AndIf} $R1 != "Emulation"
      ${AndIf} $R1 != "Recompilations"
      ${AndIf} $R1 != "VR Mods"
      ${AndIf} $R1 != "Upgrades"
        ${If} ${FileExists} "$INSTDIR\$R1\*.*"
          CreateDirectory "$PLUGINSDIR\old-install\$R1"
          Push "\$R1"
          Call un.atomicRMDir
          Pop $R2
          ${If} $R2 == 0
            StrCpy $R2 ""
          ${EndIf}
        ${Else}
          ClearErrors
          Rename "$INSTDIR\$R1" "$PLUGINSDIR\old-install\$R1"
          ${If} ${Errors}
          ; The running uninstaller cannot move itself; electron-builder ignores that too.
          ${AndIf} $R1 != "${UNINSTALL_FILENAME}"
            StrCpy $R2 "$INSTDIR\$R1"
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${If} $R2 != ""
        ; Stop at the first busy file: FindNext with the error flag set would end the loop the same way.
        SetErrors
      ${Else}
        ClearErrors
        FindNext $R0 $R1
      ${EndIf}
    ${Loop}
    FindClose $R0

    ${If} $R2 != ""
      DetailPrint "File is busy, aborting: $R2"
      ; Put back everything moved so far; the folders it came from are still there (only files were moved).
      Push ""
      Call un.restoreFiles
      Pop $R0
      Pop $R2
      Pop $R1
      Pop $R0
      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${EndIf}
  ${EndIf}

  ; Delete what is left (everything on uninstall; the emptied folders and the uninstaller on update).
  ClearErrors
  FindFirst $R0 $R1 "$INSTDIR\*.*"
  ${DoUntil} ${Errors}
    ${If} $R1 != "."
    ${AndIf} $R1 != ".."
    ${AndIf} $R1 != "Emulators"
    ${AndIf} $R1 != "Emulation"
    ${AndIf} $R1 != "Recompilations"
    ${AndIf} $R1 != "VR Mods"
    ${AndIf} $R1 != "Upgrades"
      ${If} ${FileExists} "$INSTDIR\$R1\*.*"
        RMDir /r "$INSTDIR\$R1"
      ${Else}
        Delete "$INSTDIR\$R1"
      ${EndIf}
    ${EndIf}
    ; A file that could not be removed sets the error flag too: only FindNext ends the loop.
    ClearErrors
    FindNext $R0 $R1
  ${Loop}
  FindClose $R0
  Pop $R2
  Pop $R1
  Pop $R0
  ; Removed only when empty (no Emulators, Emulation, Recompilations, VR Mods or Upgrades folder).
  RMDir $INSTDIR
!macroend

; ---- Install folder: <user profile>\Games\PlayOut for a first install (0.9.22) ---------------------------------------
; A first per-user install (nothing registered) defaults to <user profile>\Games\PlayOut: a per-user folder with no
; administrator approval, where PlayOut writes its Emulators, Recompilations, VR Mods and Upgrades folders beside
; PlayOut.exe. The folder page still lets the user choose another. An existing install is never moved.
;
; The user may move the whole PlayOut folder (it is portable). An installed PlayOut records the folder it runs from at
; every start (HKCU\Software\PlayOut InstallDir, src/main/util/install-move.ts). When that folder still holds PlayOut's
; uninstaller and differs from the registered one, an update or a setup run by hand goes there: it is registered first,
; so the stock old-version step runs that folder's uninstaller (its program files go, its data folders stay) and not
; the uninstaller of the folder PlayOut was installed to (gone, or a copy the user kept). A reinstall after an uninstall
; goes to the folder that kept the data folders. /D= always wins, and an install for all users is left alone (PlayOut
; records no folder under Program Files).
;
; Applied in customInit (a silent install shows no pages) and again when the "Only for me / Anyone" page is left (that
; page sets the folder again from the registry).
!ifndef BUILD_UNINSTALLER
  ; Declared for the installer only: the uninstaller build never uses it (unused variables fail the build).
  Var /GLOBAL playoutMovedFolder

  ; $playoutMovedFolder is only ever set (never cleared): a second pass (the install-mode page) finds the folder
  ; registered already and must not forget the first.
  !macro playoutChooseDir
    Push $R0
    Push $R1
    Push $R2
    ; GetDParameter keeps $R5-$R9 for itself: its answer goes to $R0.
    !insertmacro GetDParameter $R0
    ${If} $R0 == ""
    ${AndIf} $installMode == "CurrentUser"
      ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $R2 HKCU "Software\PlayOut" InstallDir
      ${If} $R1 != ""
        ; Installed for this user ($INSTDIR is the registered folder): the folder PlayOut runs from now, if the user
        ; moved it.
        ${If} $R2 != ""
        ${AndIf} $R1 != $R2
        ${AndIf} ${FileExists} "$R2\${UNINSTALL_FILENAME}"
          StrCpy $INSTDIR $R2
          StrCpy $playoutMovedFolder "1"
          WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$R2"
          WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$R2\${UNINSTALL_FILENAME}" /currentuser'
          WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$R2\${UNINSTALL_FILENAME}" /currentuser /S'
        ${EndIf}
      ${ElseIf} $R2 != ""
      ${AndIf} ${FileExists} "$R2\*.*"
        ; A reinstall after an uninstall: the folder that kept PlayOut's data folders.
        StrCpy $INSTDIR $R2
      ${ElseIfNot} ${FileExists} "$LOCALAPPDATA\Programs\${APP_FILENAME}\*.*"
        ; A first install. (A reinstall over data an older version kept in its default folder stays there.)
        StrCpy $INSTDIR "$PROFILE\Games\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
    Pop $R2
    Pop $R1
    Pop $R0
  !macroend
!endif

!macro customInit
  !insertmacro playoutChooseDir
!macroend

; Inserted just before the "Only for me / Anyone" page (LogicLib is loaded by then): no page of its own, only that
; page's leave callback.
!macro customWelcomePage
  Function playoutInstallModeLeave
    !insertmacro playoutChooseDir
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE playoutInstallModeLeave
!macroend

; An update into a folder the user moved keeps the Start menu and desktop shortcuts (they name the old folder): those
; that exist are pointed at this folder. A taskbar pin cannot be changed by an installer.
!macro customInstall
  ${If} $playoutMovedFolder == "1"
  ${AndIf} $installMode == "CurrentUser"
    ${If} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
    ${If} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
  ${EndIf}
!macroend
