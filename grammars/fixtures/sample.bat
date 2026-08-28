@echo off
setlocal enabledelayedexpansion

rem Build the CLI and stage it into the extension for local testing.
set "TARGET=x86_64-pc-windows-msvc"
set "ROOT=%~dp0.."

pushd "%ROOT%\cli" || exit /b 1
cargo build --release --target %TARGET%
if errorlevel 1 (
    echo build failed >&2
    popd
    exit /b 1
)
popd

for %%F in ("%ROOT%\cli\target\%TARGET%\release\poly.exe") do (
    set "SIZE=%%~zF"
    echo staged %%~nxF (!SIZE! bytes^)
    copy /y "%%F" "%ROOT%\extensions\lint\bin\poly.exe" >nul
)

endlocal & exit /b 0
