@echo off
rem Lanza el agente Triton con reinicio automatico si crashea.
rem Usado por la tarea programada "TritonAgent" (al iniciar sesion).
cd /d "%~dp0"
if not exist data mkdir data
:loop
echo [%date% %time%] Triton arrancando >> data\agent.log
call npm run start >> data\agent.log 2>&1
echo [%date% %time%] Triton termino (codigo %errorlevel%), reinicio en 30s >> data\agent.log
timeout /t 30 /nobreak >nul
goto loop
