@echo off
chcp 65001 >nul 2>&1
title SISTEMA DE CAIXA V2.0 - GERENCIADOR AUTOMATICO
color 0A

:: ====================================================================
::  SISTEMA DE CONTROLE DE CAIXA - INSTALADOR E GERENCIADOR V2.0
:: ====================================================================
::  Funcionalidades:
::  - Verificação de requisitos (Node.js)
::  - Instalação automática de dependências
::  - Inicialização do servidor
::  - Backup automático do banco
::  - Verificação de portas em uso
::  - Menu interativo
::  - Logs de erro
::  - Auto-restart em caso de falha
:: ====================================================================

setlocal enabledelayedexpansion

:: Variáveis de configuração
set "VERSAO=2.0.0"
set "PORTA=8001"
set "ARQUIVO_SERVIDOR=servercaixa_v2.js"
set "LOG_DIR=logs"
set "BACKUP_DIR=backups"

:: ====================================================================
:: FUNÇÃO: MENU PRINCIPAL
:: ====================================================================
:menu
cls
echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║                                                              ║
echo ║        SISTEMA DE CONTROLE DE CAIXA - VERSÃO %VERSAO%       ║
echo ║                  GERENCIADOR AUTOMÁTICO                      ║
echo ║                                                              ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.
echo  Sistema: %ARQUIVO_SERVIDOR%
echo  Porta: %PORTA%
echo.
echo ┌──────────────────────────────────────────────────────────────┐
echo │                      OPÇÕES DISPONÍVEIS                      │
echo └──────────────────────────────────────────────────────────────┘
echo.
echo   [1] Iniciar Servidor
echo   [2] Verificar Status
echo   [3] Instalar/Atualizar Dependências
echo   [4] Fazer Backup Manual do Banco
echo   [5] Ver Logs de Erro
echo   [6] Limpar Arquivos Temporários
echo   [7] Verificar Requisitos do Sistema
echo   [8] Sobre o Sistema
echo   [0] Sair
echo.
set /p opcao="Digite sua escolha: "

if "%opcao%"=="1" goto iniciar_servidor
if "%opcao%"=="2" goto verificar_status
if "%opcao%"=="3" goto instalar_dependencias
if "%opcao%"=="4" goto backup_manual
if "%opcao%"=="5" goto ver_logs
if "%opcao%"=="6" goto limpar_temp
if "%opcao%"=="7" goto verificar_requisitos
if "%opcao%"=="8" goto sobre
if "%opcao%"=="0" goto sair

echo.
color 0C
echo [ERRO] Opção inválida!
timeout /t 2 >nul
color 0A
goto menu

:: ====================================================================
:: FUNÇÃO: VERIFICAR REQUISITOS
:: ====================================================================
:verificar_requisitos
cls
echo.
echo ════════════════════════════════════════════════════════════════
echo   VERIFICANDO REQUISITOS DO SISTEMA
echo ════════════════════════════════════════════════════════════════
echo.

:: Verifica Node.js
echo [1/4] Verificando instalação do Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo ✗ FALHOU - Node.js não encontrado
    echo.
    echo ┌──────────────────────────────────────────────────────────┐
    echo │  ERRO CRÍTICO: Node.js não está instalado!              │
    echo └──────────────────────────────────────────────────────────┘
    echo.
    echo Por favor, instale o Node.js versão 18 ou superior:
    echo https://nodejs.org/
    echo.
    echo Após a instalação, execute este arquivo novamente.
    echo.
    pause
    goto menu
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo ✓ OK - Node.js !NODE_VERSION! detectado

:: Verifica NPM
echo [2/4] Verificando NPM...
npm -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo ✗ FALHOU - NPM não encontrado
    pause
    goto menu
)

for /f "tokens=*" %%i in ('npm -v') do set NPM_VERSION=%%i
echo ✓ OK - NPM !NPM_VERSION! detectado

:: Verifica arquivo do servidor
echo [3/4] Verificando arquivo do servidor...
if not exist "%ARQUIVO_SERVIDOR%" (
    color 0C
    echo ✗ FALHOU - Arquivo '%ARQUIVO_SERVIDOR%' não encontrado
    echo.
    echo O arquivo do servidor deve estar na mesma pasta que este .bat
    pause
    goto menu
)
echo ✓ OK - Servidor encontrado

:: Verifica porta
echo [4/4] Verificando se a porta %PORTA% está disponível...
netstat -ano | findstr ":%PORTA% " >nul 2>&1
if %errorlevel% equ 0 (
    color 0E
    echo ⚠ AVISO - Porta %PORTA% está em uso
    echo.
    echo Você precisará encerrar o processo antes de iniciar o servidor.
) else (
    echo ✓ OK - Porta %PORTA% disponível
)

echo.
echo ════════════════════════════════════════════════════════════════
color 0A
echo   TODOS OS REQUISITOS FORAM VERIFICADOS
echo ════════════════════════════════════════════════════════════════
echo.
pause
goto menu

:: ====================================================================
:: FUNÇÃO: INSTALAR DEPENDÊNCIAS
:: ====================================================================
:instalar_dependencias
cls
echo.
echo ════════════════════════════════════════════════════════════════
echo   INSTALANDO/ATUALIZANDO DEPENDÊNCIAS
echo ════════════════════════════════════════════════════════════════
echo.

:: Verifica se package.json existe
if not exist "package.json" (
    echo [INFO] Criando package.json...
    call npm init -y >nul 2>&1
)

echo [INFO] Instalando dependências... Isso pode demorar alguns minutos.
echo.
echo Pacotes a serem instalados:
echo - express (Framework web)
echo - sqlite3 (Banco de dados)
echo - multer (Upload de arquivos)
echo - xlsx (Manipulação de Excel)
echo - cors (Segurança CORS)
echo - node-cron (Agendamento)
echo - moment (Manipulação de datas)
echo - helmet (Segurança)
echo - compression (Compressão)
echo - express-rate-limit (Proteção DDoS)
echo - winston (Logs)
echo - joi (Validação)
echo.

call npm install express sqlite3 multer xlsx cors node-cron moment helmet compression express-rate-limit winston joi

if %errorlevel% neq 0 (
    color 0C
    echo.
    echo ════════════════════════════════════════════════════════════════
    echo   ERRO AO INSTALAR DEPENDÊNCIAS
    echo ════════════════════════════════════════════════════════════════
    echo.
    echo Possíveis causas:
    echo - Sem conexão com a internet
    echo - Firewall bloqueando o NPM
    echo - Permissões insuficientes
    echo.
    echo Tente executar como Administrador.
    pause
    color 0A
    goto menu
)

color 0A
echo.
echo ════════════════════════════════════════════════════════════════
echo   INSTALAÇÃO CONCLUÍDA COM SUCESSO!
echo ════════════════════════════════════════════════════════════════
echo.
pause
goto menu

:: ====================================================================
:: FUNÇÃO: VERIFICAR STATUS
:: ====================================================================
:verificar_status
cls
echo.
echo ════════════════════════════════════════════════════════════════
echo   STATUS DO SISTEMA
echo ════════════════════════════════════════════════════════════════
echo.

:: Verifica se o servidor está rodando
netstat -ano | findstr ":%PORTA% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    color 0A
    echo ✓ SERVIDOR ONLINE
    echo   Porta %PORTA% está em uso (servidor rodando)
    echo.
    
    :: Tenta pegar o PID
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORTA% " ^| findstr "LISTENING"') do (
        echo   PID do processo: %%a
        echo.
        echo   Para parar o servidor, encerre o processo %%a
        echo   ou feche a janela do servidor.
    )
) else (
    color 0E
    echo ✗ SERVIDOR OFFLINE
    echo   Porta %PORTA% está livre
    echo.
    echo   Use a opção [1] para iniciar o servidor.
)

echo.
echo ────────────────────────────────────────────────────────────────

:: Verifica arquivos importantes
echo.
echo Arquivos do sistema:
if exist "%ARQUIVO_SERVIDOR%" (echo ✓ Servidor: %ARQUIVO_SERVIDOR%) else (echo ✗ Servidor não encontrado)
if exist "sistema_caixa.db" (echo ✓ Banco de dados: sistema_caixa.db) else (echo ⚠ Banco não criado ainda)
if exist "node_modules" (echo ✓ Dependências instaladas) else (echo ✗ Dependências não instaladas)

:: Verifica pastas
echo.
echo Pastas do sistema:
if exist "%LOG_DIR%" (echo ✓ Logs: %LOG_DIR%\) else (echo ⚠ Pasta de logs não criada)
if exist "%BACKUP_DIR%" (echo ✓ Backups: %BACKUP_DIR%\) else (echo ⚠ Pasta de backups não criada)
if exist "uploads" (echo ✓ Uploads: uploads\) else (echo ⚠ Pasta de uploads não criada)

echo.
echo ════════════════════════════════════════════════════════════════
color 0A
pause
goto menu

:: ====================================================================
:: FUNÇÃO: BACKUP MANUAL
:: ====================================================================
:backup_manual
cls
echo.
echo ════════════════════════════════════════════════════════════════
echo   BACKUP MANUAL DO BANCO DE DADOS
echo ════════════════════════════════════════════════════════════════
echo.

if not exist "sistema_caixa.db" (
    color 0E
    echo ⚠ AVISO: Banco de dados não encontrado!
    echo   O banco será criado na primeira execução do servidor.
    echo.
    pause
    color 0A
    goto menu
)

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

:: Gera nome com timestamp
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set datetime=%%I
set TIMESTAMP=%datetime:~0,4%-%datetime:~4,2%-%datetime:~6,2%_%datetime:~8,2%-%datetime:~10,2%-%datetime:~12,2%
set BACKUP_FILE=%BACKUP_DIR%\backup_manual_%TIMESTAMP%.db

echo [INFO] Criando backup...
echo.
copy "sistema_caixa.db" "%BACKUP_FILE%" >nul 2>&1

if %errorlevel% equ 0 (
    color 0A
    echo ✓ BACKUP CRIADO COM SUCESSO!
    echo.
    echo Arquivo: %BACKUP_FILE%
    echo Tamanho: 
    for %%A in ("%BACKUP_FILE%") do echo %%~zA bytes
    echo.
) else (
    color 0C
    echo ✗ FALHA AO CRIAR BACKUP
    echo.
    echo Verifique se:
    echo - O arquivo do banco não está bloqueado
    echo - Você tem permissões de escrita
    echo - Há espaço em disco suficiente
    echo.
)

echo ════════════════════════════════════════════════════════════════
color 0A
pause
goto menu

:: ====================================================================
:: FUNÇÃO: VER LOGS DE ERRO
:: ====================================================================
:ver_logs
cls
echo.
echo ════════════════════════════════════════════════════════════════
echo   LOGS DE ERRO DO SISTEMA
echo ════════════════════════════════════════════════════════════════
echo.

if not exist "%LOG_DIR%\error.log" (
    color 0E
    echo ⚠ Nenhum log de erro encontrado.
    echo   Isso é normal se o servidor ainda não foi iniciado.
    echo.
    pause
    color 0A
    goto menu
)

echo [INFO] Exibindo últimas 30 linhas do log de erros:
echo.
echo ────────────────────────────────────────────────────────────────
powershell -Command "Get-Content '%LOG_DIR%\error.log' -Tail 30"
echo ────────────────────────────────────────────────────────────────
echo.
echo [INFO] Log completo em: %LOG_DIR%\error.log
echo.
pause
goto menu

:: ====================================================================
:: FUNÇÃO: LIMPAR ARQUIVOS TEMPORÁRIOS
:: ====================================================================
:limpar_temp
cls
echo.
echo ════════════════════════════════════════════════════════════════
echo   LIMPEZA DE ARQUIVOS TEMPORÁRIOS
echo ════════════════════════════════════════════════════════════════
echo.

set /p confirma="Deseja limpar uploads antigos? (S/N): "
if /i not "%confirma%"=="S" goto menu

if exist "uploads" (
    echo [INFO] Limpando pasta uploads...
    del /q "uploads\*.*" 2>nul
    echo ✓ Uploads limpos
) else (
    echo ⚠ Pasta uploads não existe
)

echo.
echo [INFO] Limpeza concluída.
echo.
pause
goto menu

:: ====================================================================
:: FUNÇÃO: SOBRE O SISTEMA
:: ====================================================================
:sobre
cls
echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║                                                              ║
echo ║            SISTEMA DE CONTROLE DE CAIXA V%VERSAO%           ║
echo ║                                                              ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.
echo  Desenvolvido para: Controle de Caixa e Importação de Excel
echo  Versão: %VERSAO%
echo  Tecnologias: Node.js, Express, SQLite, Winston
echo.
echo ┌──────────────────────────────────────────────────────────────┐
echo │                    FUNCIONALIDADES                           │
echo └──────────────────────────────────────────────────────────────┘
echo.
echo  ✓ Abertura e fechamento de caixa
echo  ✓ Importação de arquivos Excel (.xlsx, .xls)
echo  ✓ CRUD completo de movimentos financeiros
echo  ✓ Sistema de auditoria integrado
echo  ✓ Relatórios consolidados e exportação
echo  ✓ Backup automático (quartas-feiras)
echo  ✓ Proteção contra DDoS (Rate Limiting)
echo  ✓ Logs estruturados com Winston
echo  ✓ Validação robusta de dados (Joi)
echo  ✓ Segurança com Helmet
echo.
echo ┌──────────────────────────────────────────────────────────────┐
echo │                    INFORMAÇÕES TÉCNICAS                      │
echo └──────────────────────────────────────────────────────────────┘
echo.
echo  Porta do servidor: %PORTA%
echo  Arquivo principal: %ARQUIVO_SERVIDOR%
echo  Banco de dados: SQLite (sistema_caixa.db)
echo  Chave de API: Configurável via .env
echo.
echo ┌──────────────────────────────────────────────────────────────┐
echo │                    DOCUMENTAÇÃO                              │
echo └──────────────────────────────────────────────────────────────┘
echo.
echo  Consulte o arquivo README.md para documentação completa
echo  da API e instruções de uso.
echo.
echo ════════════════════════════════════════════════════════════════
pause
goto menu

:: ====================================================================
:: FUNÇÃO: INICIAR SERVIDOR
:: ====================================================================
:iniciar_servidor
cls

:: Verifica requisitos básicos
node -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo ════════════════════════════════════════════════════════════════
    echo   ERRO: Node.js não encontrado!
    echo ════════════════════════════════════════════════════════════════
    echo.
    echo Instale o Node.js antes de continuar.
    pause
    goto menu
)

if not exist "%ARQUIVO_SERVIDOR%" (
    color 0C
    echo.
    echo ════════════════════════════════════════════════════════════════
    echo   ERRO: Arquivo do servidor não encontrado!
    echo ════════════════════════════════════════════════════════════════
    echo.
    echo Arquivo esperado: %ARQUIVO_SERVIDOR%
    pause
    goto menu
)

:: Instala dependências se necessário
if not exist "node_modules" (
    echo.
    echo [INFO] Primeira execução detectada.
    echo [INFO] Instalando dependências... Aguarde.
    echo.
    
    if not exist "package.json" call npm init -y >nul 2>&1
    
    call npm install express sqlite3 multer xlsx cors node-cron moment helmet compression express-rate-limit winston joi
    
    if %errorlevel% neq 0 (
        color 0C
        echo.
        echo [ERRO] Falha ao instalar dependências.
        echo Verifique sua conexão com a internet.
        pause
        goto menu
    )
    
    echo.
    echo [SUCESSO] Dependências instaladas!
    timeout /t 2 >nul
)

:: Inicia o servidor
cls
color 0A
echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║                                                              ║
echo ║                    SERVIDOR EM EXECUÇÃO                      ║
echo ║                                                              ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.
echo  Sistema: %ARQUIVO_SERVIDOR%
echo  Porta: %PORTA%
echo  Versão: %VERSAO%
echo.
echo ┌──────────────────────────────────────────────────────────────┐
echo │  IMPORTANTE: Mantenha esta janela aberta!                   │
echo │  Para parar o servidor, pressione Ctrl+C ou feche a janela. │
echo └──────────────────────────────────────────────────────────────┘
echo.
echo ════════════════════════════════════════════════════════════════
echo.

:loop_servidor
node "%ARQUIVO_SERVIDOR%"

:: Se o servidor parar
if %errorlevel% neq 0 (
    color 0E
    echo.
    echo ════════════════════════════════════════════════════════════════
    echo   SERVIDOR PAROU INESPERADAMENTE
    echo ════════════════════════════════════════════════════════════════
    echo.
    echo Código de erro: %errorlevel%
    echo.
    echo O servidor será reiniciado em 10 segundos...
    echo Pressione Ctrl+C para cancelar e voltar ao menu.
    echo.
    timeout /t 10
    
    cls
    color 0A
    echo.
    echo [INFO] Reiniciando servidor...
    echo.
    goto loop_servidor
)

goto menu

:: ====================================================================
:: FUNÇÃO: SAIR
:: ====================================================================
:sair
cls
echo.
echo ════════════════════════════════════════════════════════════════
echo.
echo             Encerrando Sistema de Controle de Caixa
echo.
echo ════════════════════════════════════════════════════════════════
echo.
timeout /t 2 >nul
exit

endlocal