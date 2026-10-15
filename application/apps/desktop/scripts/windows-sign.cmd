@echo off
setlocal DisableDelayedExpansion
set "signTool=%WORKGROUP_DESKTOP_WINDOWS_SIGNTOOL%"
set "certificateFile=%WORKGROUP_DESKTOP_WINDOWS_CER_FILE%"
set "tokenPin=%WORKGROUP_DESKTOP_WINDOWS_TOKEN_PIN%"
set "keyContainer=%WORKGROUP_DESKTOP_WINDOWS_KEY_CONTAINER%"
set "targetFile=%WORKGROUP_DESKTOP_WINDOWS_SIGN_TARGET%"
set "appendSignature="
if "%WORKGROUP_DESKTOP_WINDOWS_SIGN_APPEND%"=="1" set "appendSignature=/as"
set "WORKGROUP_DESKTOP_WINDOWS_SIGNTOOL="
set "WORKGROUP_DESKTOP_WINDOWS_CER_FILE="
set "WORKGROUP_DESKTOP_WINDOWS_TOKEN_PIN="
set "WORKGROUP_DESKTOP_WINDOWS_KEY_CONTAINER="
set "WORKGROUP_DESKTOP_WINDOWS_SIGN_TARGET="
set "WORKGROUP_DESKTOP_WINDOWS_SIGN_APPEND="
set "signTool=" & set "certificateFile=" & set "tokenPin=" & set "keyContainer=" & set "targetFile=" & set "appendSignature=" & "%signTool%" sign /v /fd sha256 /f "%certificateFile%" /kc "[{{%tokenPin%}}]=%keyContainer%" /csp "eToken Base Cryptographic Provider" %appendSignature% "%targetFile%"
exit /b %errorlevel%
