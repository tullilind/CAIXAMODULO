/**
 * ═══════════════════════════════════════════════════════════════════════
 * SISTEMA DE CONTROLE DE CAIXA V5.0 - CORREÇÃO TOTAL DE LÓGICA FINANCEIRA
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * ✅ CORREÇÕES V5.0:
 * • LÓGICA FINANCEIRA CORRIGIDA (crédito SOMA, débito SUBTRAI)
 * • Campo UNIDADE obrigatório na abertura do caixa
 * • Detecção inteligente de forma de pagamento pela descrição
 * • Valores negativos no Excel processados corretamente
 * • Saldo calculado corretamente em todas as APIs
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const xlsx = require('xlsx');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const Joi = require('joi');

const app = express();
const PORT = process.env.PORT || 8001;
const API_KEY = process.env.API_KEY || '1526';
const DB_PATH = path.join(__dirname, 'sistema_caixa.db');
const UPLOAD_FOLDER = path.join(__dirname, 'uploads');
const BACKUP_FOLDER = path.join(__dirname, 'backups');
const LOG_FOLDER = path.join(__dirname, 'logs');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO DE LOGS
// ═══════════════════════════════════════════════════════════════════════

[UPLOAD_FOLDER, BACKUP_FOLDER, LOG_FOLDER].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ 
            filename: path.join(LOG_FOLDER, 'error.log'), 
            level: 'error',
            maxsize: 5242880,
            maxFiles: 5
        }),
        new winston.transports.File({ 
            filename: path.join(LOG_FOLDER, 'combined.log'),
            maxsize: 5242880,
            maxFiles: 5
        }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// ═══════════════════════════════════════════════════════════════════════
// VALIDAÇÃO DE SCHEMAS
// ═══════════════════════════════════════════════════════════════════════

const schemas = {
    abrirCaixa: Joi.object({
        usuario: Joi.string().min(3).max(100).required(),
        unidade: Joi.string().min(3).max(100).required(), // ✅ UNIDADE AGORA É OBRIGATÓRIA
        saldo_inicial_informado: Joi.number().optional()
    }),
    
    registrarMovimento: Joi.object({
        requisicao: Joi.string().allow('').optional(),
        data_cadastro: Joi.string().optional(),
        usuario: Joi.string().required(),
        valor: Joi.number().required(),
        tipo_transacao: Joi.string().valid('DEBITO', 'CREDITO').required(),
        forma_pagamento: Joi.string().valid('PIX', 'DINHEIRO', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'TRANSFERENCIA', 'DEPOSITO', 'OUTRO').required(),
        descricao_transacao: Joi.string().allow('').optional(),
        posto_coleta: Joi.string().allow('').optional()
    }),
    
    editarMovimento: Joi.object({
        requisicao: Joi.string().allow('').optional(),
        usuario: Joi.string().optional(),
        valor: Joi.number().optional(),
        tipo_transacao: Joi.string().valid('DEBITO', 'CREDITO').optional(),
        forma_pagamento: Joi.string().valid('PIX', 'DINHEIRO', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'TRANSFERENCIA', 'DEPOSITO', 'OUTRO').optional(),
        descricao_transacao: Joi.string().allow('').optional(),
        posto_coleta: Joi.string().allow('').optional(),
        motivo_edicao: Joi.string().required()
    })
};

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO MULTER
// ═══════════════════════════════════════════════════════════════════════

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_FOLDER),
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `import_${Date.now()}_${safeName}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls)$/i)) {
        cb(null, true);
    } else {
        cb(new Error('Apenas arquivos Excel (.xlsx, .xls) são permitidos.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }
});

// ═══════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { erro: true, mensagem: 'Muitas requisições. Tente novamente mais tarde.' }
});
app.use('/api/', limiter);

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: { erro: true, mensagem: 'Limite de importações atingido.' }
});

const authMiddleware = (req, res, next) => {
    const token = req.headers['x-api-key'];
    if (!token || token !== API_KEY) {
        logger.warn(`Acesso não autorizado de IP: ${req.ip}`);
        return res.status(401).json({ 
            erro: true, 
            mensagem: 'Acesso negado. Chave de segurança inválida.' 
        });
    }
    next();
};

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        logger.info({
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: `${Date.now() - start}ms`,
            ip: req.ip
        });
    });
    next();
});

// ═══════════════════════════════════════════════════════════════════════
// BANCO DE DADOS
// ═══════════════════════════════════════════════════════════════════════

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        logger.error('Erro ao conectar ao SQLite:', err);
        process.exit(1);
    }
    logger.info('✅ Conectado ao banco de dados SQLite.');
    inicializarTabelas();
});

function inicializarTabelas() {
    db.serialize(() => {
        // ✅ TABELA DE CAIXA COM CAMPO UNIDADE
        db.run(`
            CREATE TABLE IF NOT EXISTS caixa_controle (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario_abertura TEXT NOT NULL,
                unidade TEXT NOT NULL,
                data_abertura DATETIME DEFAULT CURRENT_TIMESTAMP,
                data_fechamento DATETIME,
                saldo_inicial REAL DEFAULT 0,
                saldo_final REAL DEFAULT 0,
                status TEXT DEFAULT 'ABERTO' CHECK(status IN ('ABERTO', 'FECHADO')),
                observacoes TEXT
            )
        `);

        // Verifica se a coluna unidade existe, se não, adiciona
        db.all("PRAGMA table_info(caixa_controle)", [], (err, columns) => {
            if (!err) {
                const hasUnidade = columns.some(col => col.name === 'unidade');
                if (!hasUnidade) {
                    db.run("ALTER TABLE caixa_controle ADD COLUMN unidade TEXT DEFAULT ''", (err) => {
                        if (err) {
                            logger.warn('Coluna unidade já existe ou erro ao adicionar:', err.message);
                        } else {
                            logger.info('✅ Coluna unidade adicionada à tabela caixa_controle');
                        }
                    });
                }
            }
        });

        db.run(`
            CREATE TABLE IF NOT EXISTS movimentos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                id_caixa INTEGER NOT NULL,
                requisicao TEXT NOT NULL,
                data_cadastro TEXT NOT NULL,
                usuario TEXT NOT NULL,
                valor REAL NOT NULL,
                tipo_transacao TEXT NOT NULL CHECK(tipo_transacao IN ('DEBITO', 'CREDITO')),
                forma_pagamento TEXT NOT NULL CHECK(forma_pagamento IN ('PIX', 'DINHEIRO', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'TRANSFERENCIA', 'DEPOSITO', 'OUTRO')),
                descricao_transacao TEXT,
                posto_coleta TEXT,
                criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
                editado_em DATETIME,
                FOREIGN KEY(id_caixa) REFERENCES caixa_controle(id) ON DELETE RESTRICT
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS auditoria (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario TEXT NOT NULL,
                acao TEXT NOT NULL,
                tabela TEXT,
                registro_id INTEGER,
                dados_anteriores TEXT,
                dados_novos TEXT,
                ip TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        db.run("CREATE INDEX IF NOT EXISTS idx_movimentos_caixa ON movimentos(id_caixa)");
        db.run("CREATE INDEX IF NOT EXISTS idx_movimentos_usuario ON movimentos(usuario)");
        db.run("CREATE INDEX IF NOT EXISTS idx_movimentos_data ON movimentos(data_cadastro)");
        db.run("CREATE INDEX IF NOT EXISTS idx_movimentos_tipo ON movimentos(tipo_transacao)");
        db.run("CREATE INDEX IF NOT EXISTS idx_movimentos_posto ON movimentos(posto_coleta)");
        db.run("CREATE INDEX IF NOT EXISTS idx_caixa_unidade ON caixa_controle(unidade)");

        logger.info('✅ Tabelas e índices verificados/criados.');
    });
}

// ═══════════════════════════════════════════════════════════════════════
// FUNÇÕES AUXILIARES
// ═══════════════════════════════════════════════════════════════════════

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        err ? reject(err) : resolve(this);
    });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        err ? reject(err) : resolve(row);
    });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        err ? reject(err) : resolve(rows);
    });
});

async function getCaixaAberto() {
    return await dbGet("SELECT * FROM caixa_controle WHERE status = 'ABERTO' LIMIT 1");
}

async function registrarAuditoria(usuario, acao, tabela, registroId, dadosAnteriores, dadosNovos, ip) {
    try {
        await dbRun(
            `INSERT INTO auditoria (usuario, acao, tabela, registro_id, dados_anteriores, dados_novos, ip)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [usuario, acao, tabela, registroId, JSON.stringify(dadosAnteriores), JSON.stringify(dadosNovos), ip]
        );
    } catch (error) {
        logger.error('Erro ao registrar auditoria:', error);
    }
}

/**
 * ✅ FUNÇÃO MELHORADA: Detecta forma de pagamento pela descrição
 */
function detectarFormaPagamento(descricao) {
    if (!descricao || typeof descricao !== 'string') {
        return 'OUTRO';
    }

    const desc = descricao.toLowerCase().trim();
    
    // ✅ DETECÇÃO PRECISA DE FORMA DE PAGAMENTO
    
    // PIX - detecta "pix" como palavra isolada ou com espaços
    if (desc === 'pix' || desc.match(/\bpix\b/)) {
        return 'PIX';
    }
    
    // CARTÃO DÉBITO
    if (desc === 'c.d' || desc === 'cd' || desc === 'c d' || 
        desc.match(/\bc\.?d\b/) || 
        desc.includes('cartao debito') || desc.includes('cartão debito') ||
        desc.includes('cartao de debito') || desc.includes('cartão de débito') ||
        desc.includes('debito') || desc.includes('débito')) {
        return 'CARTAO_DEBITO';
    }
    
    // CARTÃO CRÉDITO
    if (desc === 'c.c' || desc === 'cc' || desc === 'c c' || 
        desc.match(/\bc\.?c\b/) ||
        desc.includes('cartao credito') || desc.includes('cartão credito') ||
        desc.includes('cartao de credito') || desc.includes('cartão de crédito') ||
        desc.includes('credito') || desc.includes('crédito')) {
        return 'CARTAO_CREDITO';
    }
    
    // DINHEIRO
    if (desc.includes('dinheiro') || desc.includes('especie') || desc.includes('espécie') ||
        desc === 'cash' || desc.includes('moeda')) {
        return 'DINHEIRO';
    }
    
    // TRANSFERÊNCIA
    if (desc.includes('transferencia') || desc.includes('transferência') ||
        desc.includes('ted') || desc.includes('doc')) {
        return 'TRANSFERENCIA';
    }
    
    // DEPÓSITO
    if (desc.includes('deposito') || desc.includes('depósito')) {
        return 'DEPOSITO';
    }
    
    // Se não identificou, retorna OUTRO
    return 'OUTRO';
}

/**
 * ✅ FUNÇÃO CORRIGIDA: Processa valores do Excel corretamente
 * Agora detecta o sinal negativo no valor original
 */
function processarValorExcel(valorBruto) {
    let valor = valorBruto;
    let isNegativo = false;
    
    if (typeof valor === 'string') {
        // Remove R$ e espaços
        valor = valor.trim();
        
        // ✅ DETECTA SINAL NEGATIVO
        if (valor.startsWith('-') || valor.startsWith('−')) {
            isNegativo = true;
            valor = valor.substring(1).trim();
        }
        
        // Remove R$
        valor = valor.replace(/R\$\s?/g, '').trim();
        
        // Detecta se usa vírgula ou ponto como decimal
        if (valor.includes(',')) {
            // Formato brasileiro: remove pontos e troca vírgula por ponto
            valor = valor.replace(/\./g, '').replace(',', '.');
        } else {
            // Formato internacional: remove vírgulas
            valor = valor.replace(/,/g, '');
        }
        
        valor = parseFloat(valor);
    }
    
    // ✅ DETECTA SINAL NEGATIVO EM NÚMEROS
    if (typeof valorBruto === 'number' && valorBruto < 0) {
        isNegativo = true;
        valor = Math.abs(valorBruto);
    }
    
    if (isNaN(valor)) valor = 0;
    
    // ✅ LÓGICA CORRETA: Valor negativo = DÉBITO, Valor positivo = CRÉDITO
    const tipo_transacao = isNegativo ? 'DEBITO' : 'CREDITO';
    const valor_absoluto = Math.abs(valor);
    
    return { valor: valor_absoluto, tipo_transacao };
}

/**
 * ✅ FUNÇÃO PARA CALCULAR SALDO CORRETAMENTE
 */
function calcularSaldo(saldoInicial, totalCredito, totalDebito) {
    const saldo = parseFloat(saldoInicial) + parseFloat(totalCredito || 0) - parseFloat(totalDebito || 0);
    return parseFloat(saldo.toFixed(2));
}

async function realizarBackup() {
    const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
    const backupPath = path.join(BACKUP_FOLDER, `backup_caixa_${timestamp}.db`);
    
    return new Promise((resolve, reject) => {
        fs.copyFile(DB_PATH, backupPath, (err) => {
            if (err) {
                logger.error('Erro no backup:', err);
                reject(err);
            } else {
                logger.info(`✅ Backup realizado: ${backupPath}`);
                resolve(backupPath);
            }
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════
// ROTAS DA API
// ═══════════════════════════════════════════════════════════════════════

app.get('/api/status', (req, res) => {
    res.json({ 
        status: 'ONLINE', 
        versao: '5.0',
        porta: PORT, 
        timestamp: new Date(),
        uptime: Math.floor(process.uptime()) + 's'
    });
});

// ───────────────────────────────────────────────────────────────────────
// 1. ✅ ABRIR CAIXA (COM UNIDADE OBRIGATÓRIA)
// ───────────────────────────────────────────────────────────────────────

app.post('/api/caixa/abrir', authMiddleware, async (req, res) => {
    try {
        const { error, value } = schemas.abrirCaixa.validate(req.body);
        if (error) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Validação falhou', 
                detalhes: error.details 
            });
        }

        const caixaAberto = await getCaixaAberto();
        if (caixaAberto) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Já existe um caixa aberto.', 
                dados: {
                    id: caixaAberto.id,
                    aberto_por: caixaAberto.usuario_abertura,
                    unidade: caixaAberto.unidade,
                    data_abertura: caixaAberto.data_abertura
                }
            });
        }

        const ultimoFechamento = await dbGet(
            "SELECT saldo_final FROM caixa_controle WHERE status = 'FECHADO' ORDER BY id DESC LIMIT 1"
        );
        const saldoInicial = value.saldo_inicial_informado ?? (ultimoFechamento?.saldo_final || 0.0);

        const result = await dbRun(
            `INSERT INTO caixa_controle (usuario_abertura, unidade, saldo_inicial, status) 
             VALUES (?, ?, ?, 'ABERTO')`,
            [value.usuario, value.unidade, saldoInicial]
        );

        await registrarAuditoria(
            value.usuario, 'ABERTURA_CAIXA', 'caixa_controle', result.lastID,
            null, { saldo_inicial: saldoInicial, unidade: value.unidade }, req.ip
        );

        logger.info(`✅ Caixa aberto por ${value.usuario} na unidade ${value.unidade} - ID: ${result.lastID}`);

        res.json({ 
            sucesso: true, 
            mensagem: 'Caixa aberto com sucesso.', 
            dados: {
                id_caixa: result.lastID,
                saldo_inicial: saldoInicial,
                usuario: value.usuario,
                unidade: value.unidade,
                data_abertura: moment().format('YYYY-MM-DD HH:mm:ss')
            }
        });

    } catch (error) {
        logger.error('Erro ao abrir caixa:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 2. ✅ IMPORTAR EXCEL (LÓGICA TOTALMENTE CORRIGIDA)
// ───────────────────────────────────────────────────────────────────────

app.post('/api/importar', authMiddleware, uploadLimiter, upload.single('arquivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ erro: true, mensagem: 'Nenhum arquivo enviado.' });
    }

    const filePath = req.file.path;
    
    try {
        const caixa = await getCaixaAberto();
        if (!caixa) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'É necessário abrir o caixa antes de importar.' 
            });
        }

        logger.info(`📥 Importando arquivo: ${req.file.originalname}`);

        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        const rawData = xlsx.utils.sheet_to_json(sheet, { 
            raw: false, 
            dateNF: 'yyyy-mm-dd',
            defval: ''
        });
        
        if (rawData.length === 0) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Arquivo vazio ou sem dados válidos.' 
            });
        }

        let importados = 0;
        let erros = [];
        const errosDetalhados = [];

        await dbRun("BEGIN TRANSACTION");

        for (let i = 0; i < rawData.length; i++) {
            const row = rawData[i];
            const linhaExcel = i + 2;

            try {
                // Requisição pode ser vazia
                let requisicao = row['Requisicao'] || row['requisicao'] || row['Requisição'] || '';
                
                // ✅ USA DataTransacao PRIMEIRO
                let dataCadastro = row['DataTransacao'] || row['DataCadastro'] || row['Data'] || '';
                
                if (dataCadastro) {
                    const formatos = ['DD/MM/YYYY HH:mm:ss', 'DD/MM/YYYY HH:mm', 'DD/MM/YYYY', 'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD'];
                    const dataParsed = moment(dataCadastro, formatos, true);
                    
                    if (dataParsed.isValid()) {
                        dataCadastro = dataParsed.format('YYYY-MM-DD HH:mm:ss');
                    } else {
                        dataCadastro = moment().format('YYYY-MM-DD HH:mm:ss');
                    }
                } else {
                    dataCadastro = moment().format('YYYY-MM-DD HH:mm:ss');
                }

                const usuario = row['Usuario'] || row['Nome'] || row['Usuário'] || 'Importação';
                
                // ✅ PROCESSA VALOR COM DETECÇÃO DE SINAL NEGATIVO
                const rawValor = row['Pagamento'] || row['TotalPago'] || row['Valor'] || row['Total'] || 0;
                const { valor, tipo_transacao } = processarValorExcel(rawValor);

                const descricao = row['DescricaoTransacao'] || row['Descricao'] || row['Descrição'] || row['Observacao'] || '';
                const posto = row['PostoColeta'] || row['Departamento'] || row['Posto'] || row['Unidade'] || '';
                
                // ✅ DETECÇÃO INTELIGENTE DE FORMA DE PAGAMENTO
                let forma_pagamento = row['FormaPagamento'] || row['Forma'] || row['TipoPagamento'] || '';
                
                if (!forma_pagamento || forma_pagamento.trim() === '') {
                    // Tenta detectar pela descrição
                    forma_pagamento = detectarFormaPagamento(descricao);
                } else {
                    forma_pagamento = forma_pagamento.toUpperCase().trim();
                    const mapeamento = {
                        'DINHEIRO': 'DINHEIRO',
                        'CASH': 'DINHEIRO',
                        'PIX': 'PIX',
                        'CARTAO': 'CARTAO_DEBITO',
                        'CARTÃO': 'CARTAO_DEBITO',
                        'DEBITO': 'CARTAO_DEBITO',
                        'DÉBITO': 'CARTAO_DEBITO',
                        'CREDITO': 'CARTAO_CREDITO',
                        'CRÉDITO': 'CARTAO_CREDITO',
                        'TRANSFERENCIA': 'TRANSFERENCIA',
                        'TRANSFERÊNCIA': 'TRANSFERENCIA',
                        'DEPOSITO': 'DEPOSITO',
                        'DEPÓSITO': 'DEPOSITO',
                        'C.D': 'CARTAO_DEBITO',
                        'C.C': 'CARTAO_CREDITO',
                        'CD': 'CARTAO_DEBITO',
                        'CC': 'CARTAO_CREDITO'
                    };
                    forma_pagamento = mapeamento[forma_pagamento] || 'OUTRO';
                }

                // Se não tem requisição, gera automática
                if (!requisicao || requisicao.trim() === '') {
                    requisicao = `MANUAL-${Date.now()}-${i}`;
                }

                // Valida se tem pelo menos valor ou descrição
                if (valor === 0 && !descricao) {
                    throw new Error('Registro vazio (sem valor e sem descrição)');
                }

                // ✅ INSERE COM TODOS OS CAMPOS
                await dbRun(
                    `INSERT INTO movimentos 
                     (id_caixa, requisicao, data_cadastro, usuario, valor, tipo_transacao, forma_pagamento, descricao_transacao, posto_coleta)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [caixa.id, requisicao, dataCadastro, usuario, valor, tipo_transacao, forma_pagamento, descricao, posto]
                );
                
                importados++;
                
                logger.info(`✅ Linha ${linhaExcel}: ${tipo_transacao} R$ ${valor.toFixed(2)} - ${forma_pagamento} - ${descricao || 'sem descrição'}`);

            } catch (e) {
                erros.push(linhaExcel);
                errosDetalhados.push({
                    linha: linhaExcel,
                    erro: e.message,
                    dados: row
                });
                logger.warn(`⚠️ Erro na linha ${linhaExcel}:`, e.message);
            }
        }

        await dbRun("COMMIT");
        
        await registrarAuditoria(
            'sistema', 'IMPORTACAO_EXCEL', 'movimentos', caixa.id,
            null, { total: rawData.length, importados, erros: erros.length }, req.ip
        );

        fs.unlinkSync(filePath);

        logger.info(`✅ Importação finalizada: ${importados} registros, ${erros.length} erros`);

        res.json({
            sucesso: true,
            mensagem: 'Importação finalizada.',
            detalhes: {
                total_processado: rawData.length,
                importados: importados,
                falhas: erros.length,
                linhas_com_erro: erros.length > 0 ? erros : undefined,
                erros_detalhados: errosDetalhados.length > 0 && errosDetalhados.length <= 10 
                    ? errosDetalhados 
                    : undefined,
                id_caixa: caixa.id
            }
        });

    } catch (error) {
        await dbRun("ROLLBACK");
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
        logger.error('Erro crítico na importação:', error);
        res.status(500).json({ 
            erro: true, 
            mensagem: 'Erro crítico na importação: ' + error.message 
        });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 3. LISTAR MOVIMENTOS
// ───────────────────────────────────────────────────────────────────────

app.get('/api/movimentos', authMiddleware, async (req, res) => {
    try {
        const { 
            pagina = 1, 
            limite = 50, 
            usuario, 
            unidade,
            data_inicio,
            data_fim,
            valor_min,
            valor_max,
            requisicao,
            tipo_transacao,
            forma_pagamento
        } = req.query;
        
        const offset = (pagina - 1) * limite;
        
        let query = "SELECT * FROM movimentos WHERE 1=1";
        let params = [];

        if (usuario) {
            query += " AND usuario LIKE ?";
            params.push(`%${usuario}%`);
        }
        if (unidade) {
            query += " AND posto_coleta LIKE ?";
            params.push(`%${unidade}%`);
        }
        if (requisicao) {
            query += " AND requisicao LIKE ?";
            params.push(`%${requisicao}%`);
        }
        if (tipo_transacao) {
            query += " AND tipo_transacao = ?";
            params.push(tipo_transacao);
        }
        if (forma_pagamento) {
            query += " AND forma_pagamento = ?";
            params.push(forma_pagamento);
        }
        if (data_inicio) {
            query += " AND DATE(data_cadastro) >= ?";
            params.push(data_inicio);
        }
        if (data_fim) {
            query += " AND DATE(data_cadastro) <= ?";
            params.push(data_fim);
        }
        if (valor_min) {
            query += " AND valor >= ?";
            params.push(parseFloat(valor_min));
        }
        if (valor_max) {
            query += " AND valor <= ?";
            params.push(parseFloat(valor_max));
        }

        const countQuery = `SELECT COUNT(*) as total FROM (${query})`;
        const totalResult = await dbGet(countQuery, params);
        const totalRegistros = totalResult.total;

        query += " ORDER BY data_cadastro DESC LIMIT ? OFFSET ?";
        params.push(parseInt(limite), offset);

        const movimentos = await dbAll(query, params);

        // Query para somas (sem LIMIT/OFFSET)
        const paramsBase = params.slice(0, -2);
        
        const somaCredito = await dbGet(
            query.replace(/ ORDER BY.*?LIMIT.*?OFFSET.*?$/i, '') + " AND tipo_transacao = 'CREDITO'",
            paramsBase
        );
        const somaDebito = await dbGet(
            query.replace(/ ORDER BY.*?LIMIT.*?OFFSET.*?$/i, '') + " AND tipo_transacao = 'DEBITO'",
            paramsBase
        );
        
        // ✅ Query corrigida para total
        const totalCreditoQuery = `SELECT SUM(valor) as total FROM movimentos WHERE 1=1`;
        let totalParams = [];
        let totalWhere = '';
        
        if (usuario) {
            totalWhere += " AND usuario LIKE ?";
            totalParams.push(`%${usuario}%`);
        }
        if (unidade) {
            totalWhere += " AND posto_coleta LIKE ?";
            totalParams.push(`%${unidade}%`);
        }
        if (requisicao) {
            totalWhere += " AND requisicao LIKE ?";
            totalParams.push(`%${requisicao}%`);
        }
        if (data_inicio) {
            totalWhere += " AND DATE(data_cadastro) >= ?";
            totalParams.push(data_inicio);
        }
        if (data_fim) {
            totalWhere += " AND DATE(data_cadastro) <= ?";
            totalParams.push(data_fim);
        }
        if (valor_min) {
            totalWhere += " AND valor >= ?";
            totalParams.push(parseFloat(valor_min));
        }
        if (valor_max) {
            totalWhere += " AND valor <= ?";
            totalParams.push(parseFloat(valor_max));
        }
        
        const totalCredito = await dbGet(
            totalCreditoQuery + totalWhere + " AND tipo_transacao = 'CREDITO'",
            totalParams
        );
        const totalDebito = await dbGet(
            totalCreditoQuery + totalWhere + " AND tipo_transacao = 'DEBITO'",
            totalParams
        );

        res.json({
            sucesso: true,
            dados: movimentos,
            estatisticas: {
                total_registros: totalRegistros,
                total_credito: totalCredito?.total || 0,
                total_debito: totalDebito?.total || 0,
                saldo_liquido: (totalCredito?.total || 0) - (totalDebito?.total || 0),
                registros_pagina: movimentos.length
            },
            paginacao: {
                pagina_atual: parseInt(pagina),
                total_paginas: Math.ceil(totalRegistros / limite),
                registros_por_pagina: parseInt(limite),
                total_registros: totalRegistros
            }
        });

    } catch (error) {
        logger.error('Erro ao listar movimentos:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 4. REGISTRAR MOVIMENTO MANUAL
// ───────────────────────────────────────────────────────────────────────

app.post('/api/movimento', authMiddleware, async (req, res) => {
    try {
        const { error, value } = schemas.registrarMovimento.validate(req.body);
        if (error) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Validação falhou', 
                detalhes: error.details 
            });
        }

        const caixa = await getCaixaAberto();
        if (!caixa) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Caixa fechado. Abra o caixa para lançar movimentos.' 
            });
        }

        const dataCadastro = value.data_cadastro || moment().format('YYYY-MM-DD HH:mm:ss');
        
        let requisicao = value.requisicao;
        if (!requisicao || requisicao.trim() === '') {
            requisicao = `MANUAL-${Date.now()}`;
        }

        const result = await dbRun(
            `INSERT INTO movimentos 
             (id_caixa, requisicao, data_cadastro, usuario, valor, tipo_transacao, forma_pagamento, descricao_transacao, posto_coleta)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                caixa.id, 
                requisicao, 
                dataCadastro, 
                value.usuario, 
                value.valor, 
                value.tipo_transacao,
                value.forma_pagamento,
                value.descricao_transacao || '', 
                value.posto_coleta || ''
            ]
        );

        await registrarAuditoria(
            value.usuario, 'CRIAR_MOVIMENTO', 'movimentos', result.lastID,
            null, value, req.ip
        );

        logger.info(`✅ Movimento registrado - ID: ${result.lastID} por ${value.usuario}`);

        res.json({ 
            sucesso: true, 
            mensagem: 'Lançamento registrado com sucesso.',
            id: result.lastID,
            requisicao: requisicao
        });

    } catch (error) {
        logger.error('Erro ao registrar movimento:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 5. EDITAR MOVIMENTO
// ───────────────────────────────────────────────────────────────────────

app.put('/api/movimento/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    
    try {
        const { error, value } = schemas.editarMovimento.validate(req.body);
        if (error) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Validação falhou', 
                detalhes: error.details 
            });
        }

        const movimento = await dbGet(
            `SELECT m.*, c.status FROM movimentos m 
             JOIN caixa_controle c ON m.id_caixa = c.id 
             WHERE m.id = ?`, 
            [id]
        );
        
        if (!movimento) {
            return res.status(404).json({ erro: true, mensagem: 'Movimento não encontrado.' });
        }
        
        if (movimento.status === 'FECHADO') {
            return res.status(403).json({ 
                erro: true, 
                mensagem: 'Não é possível editar movimentos de um caixa já fechado.' 
            });
        }

        const updates = [];
        const params = [];
        
        ['requisicao', 'usuario', 'valor', 'tipo_transacao', 'forma_pagamento', 'descricao_transacao', 'posto_coleta'].forEach(field => {
            if (value[field] !== undefined) {
                updates.push(`${field} = ?`);
                params.push(value[field]);
            }
        });

        if (updates.length === 0) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Nenhum campo para atualizar.' 
            });
        }

        updates.push('editado_em = CURRENT_TIMESTAMP');
        params.push(id);

        await dbRun(
            `UPDATE movimentos SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        await registrarAuditoria(
            value.usuario || 'sistema', 'EDITAR_MOVIMENTO', 'movimentos', id,
            movimento, { ...value, motivo: value.motivo_edicao }, req.ip
        );

        logger.info(`✅ Movimento editado - ID: ${id}`);

        res.json({ sucesso: true, mensagem: 'Movimento atualizado com sucesso.' });

    } catch (error) {
        logger.error('Erro ao editar movimento:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 6. APAGAR MOVIMENTO
// ───────────────────────────────────────────────────────────────────────

app.delete('/api/movimento/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { motivo, usuario } = req.body;

    if (!motivo) {
        return res.status(400).json({ 
            erro: true, 
            mensagem: 'Motivo da exclusão é obrigatório.' 
        });
    }

    try {
        const movimento = await dbGet(
            `SELECT m.*, c.status FROM movimentos m 
             JOIN caixa_controle c ON m.id_caixa = c.id 
             WHERE m.id = ?`, 
            [id]
        );
        
        if (!movimento) {
            return res.status(404).json({ erro: true, mensagem: 'Movimento não encontrado.' });
        }
        
        if (movimento.status === 'FECHADO') {
            return res.status(403).json({ 
                erro: true, 
                mensagem: 'Não é possível apagar movimentos de um caixa já fechado.' 
            });
        }

        await dbRun("DELETE FROM movimentos WHERE id = ?", [id]);

        await registrarAuditoria(
            usuario || 'sistema', 'EXCLUIR_MOVIMENTO', 'movimentos', id,
            movimento, { motivo }, req.ip
        );

        logger.info(`✅ Movimento removido - ID: ${id}`);

        res.json({ sucesso: true, mensagem: 'Movimento removido com sucesso.' });

    } catch (error) {
        logger.error('Erro ao apagar movimento:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 7. ✅ SALDO ATUAL (LÓGICA CORRIGIDA)
// ───────────────────────────────────────────────────────────────────────

app.get('/api/caixa/saldo', authMiddleware, async (req, res) => {
    try {
        const caixa = await getCaixaAberto();
        
        if (!caixa) {
            return res.json({ 
                status: 'FECHADO', 
                saldo_atual: 0, 
                mensagem: 'Nenhum caixa aberto no momento.' 
            });
        }

        const totais = await dbGet(
            `SELECT 
                SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as total_credito,
                SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as total_debito,
                COUNT(*) as quantidade
             FROM movimentos WHERE id_caixa = ?`, 
            [caixa.id]
        );
        
        // ✅ CÁLCULO CORRETO: Saldo = Inicial + Créditos - Débitos
        const saldoAtual = calcularSaldo(caixa.saldo_inicial, totais.total_credito, totais.total_debito);

        const porPosto = await dbAll(
            `SELECT 
                posto_coleta,
                SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as credito,
                SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as debito,
                COUNT(*) as quantidade
             FROM movimentos 
             WHERE id_caixa = ? AND posto_coleta != '' 
             GROUP BY posto_coleta 
             ORDER BY (credito - debito) DESC`,
            [caixa.id]
        );

        const porUsuario = await dbAll(
            `SELECT 
                usuario,
                SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as credito,
                SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as debito,
                COUNT(*) as quantidade
             FROM movimentos 
             WHERE id_caixa = ? 
             GROUP BY usuario 
             ORDER BY (credito - debito) DESC`,
            [caixa.id]
        );

        const porFormaPagamento = await dbAll(
            `SELECT 
                forma_pagamento,
                SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as credito,
                SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as debito,
                COUNT(*) as quantidade
             FROM movimentos 
             WHERE id_caixa = ? 
             GROUP BY forma_pagamento 
             ORDER BY (credito - debito) DESC`,
            [caixa.id]
        );

        res.json({
            status: 'ABERTO',
            id_caixa: caixa.id,
            usuario_abertura: caixa.usuario_abertura,
            unidade: caixa.unidade,
            data_abertura: caixa.data_abertura,
            tempo_aberto: moment().diff(moment(caixa.data_abertura), 'hours') + ' horas',
            saldo_inicial: parseFloat(caixa.saldo_inicial.toFixed(2)),
            movimentacoes: {
                total_credito: parseFloat((totais.total_credito || 0).toFixed(2)),
                total_debito: parseFloat((totais.total_debito || 0).toFixed(2)),
                quantidade: totais.quantidade || 0
            },
            saldo_atual: saldoAtual,
            detalhamento: {
                por_posto: porPosto.map(p => ({
                    ...p,
                    credito: parseFloat(p.credito.toFixed(2)),
                    debito: parseFloat(p.debito.toFixed(2)),
                    saldo: parseFloat((p.credito - p.debito).toFixed(2))
                })),
                por_usuario: porUsuario.map(u => ({
                    ...u,
                    credito: parseFloat(u.credito.toFixed(2)),
                    debito: parseFloat(u.debito.toFixed(2)),
                    saldo: parseFloat((u.credito - u.debito).toFixed(2))
                })),
                por_forma_pagamento: porFormaPagamento.map(f => ({
                    ...f,
                    credito: parseFloat(f.credito.toFixed(2)),
                    debito: parseFloat(f.debito.toFixed(2)),
                    saldo: parseFloat((f.credito - f.debito).toFixed(2))
                }))
            }
        });

    } catch (error) {
        logger.error('Erro ao consultar saldo:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 8. ✅ FECHAR CAIXA (LÓGICA CORRIGIDA)
// ───────────────────────────────────────────────────────────────────────

app.post('/api/caixa/fechar', authMiddleware, async (req, res) => {
    const { usuario, observacoes } = req.body;

    try {
        const caixa = await getCaixaAberto();
        if (!caixa) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Não há caixa aberto para fechar.' 
            });
        }

        const totais = await dbGet(
            `SELECT 
                SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as total_credito,
                SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as total_debito,
                COUNT(*) as quantidade
             FROM movimentos WHERE id_caixa = ?`, 
            [caixa.id]
        );
        
        // ✅ CÁLCULO CORRETO DO SALDO FINAL
        const saldoFinal = calcularSaldo(caixa.saldo_inicial, totais.total_credito, totais.total_debito);
        const dataFechamento = moment().format('YYYY-MM-DD HH:mm:ss');

        await dbRun(
            `UPDATE caixa_controle 
             SET status = 'FECHADO', 
                 saldo_final = ?, 
                 data_fechamento = ?,
                 observacoes = ?
             WHERE id = ?`,
            [saldoFinal, dataFechamento, observacoes || '', caixa.id]
        );

        await registrarAuditoria(
            usuario || 'sistema', 'FECHAMENTO_CAIXA', 'caixa_controle', caixa.id,
            caixa, { saldo_final: saldoFinal, observacoes }, req.ip
        );

        logger.info(`✅ Caixa fechado - ID: ${caixa.id}, Saldo Final: ${saldoFinal}`);

        res.json({
            sucesso: true,
            mensagem: 'Caixa fechado com sucesso.',
            resumo: {
                id_caixa: caixa.id,
                unidade: caixa.unidade,
                data_abertura: caixa.data_abertura,
                data_fechamento: dataFechamento,
                saldo_inicial: parseFloat(caixa.saldo_inicial.toFixed(2)),
                movimentacoes: {
                    total_credito: parseFloat((totais.total_credito || 0).toFixed(2)),
                    total_debito: parseFloat((totais.total_debito || 0).toFixed(2)),
                    quantidade: totais.quantidade || 0
                },
                saldo_final: saldoFinal,
                tempo_operacao: moment(dataFechamento).diff(moment(caixa.data_abertura), 'hours') + ' horas'
            }
        });

    } catch (error) {
        logger.error('Erro ao fechar caixa:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 9. BACKUP MANUAL
// ───────────────────────────────────────────────────────────────────────

app.post('/api/backup', authMiddleware, async (req, res) => {
    try {
        const caminho = await realizarBackup();
        
        await registrarAuditoria(
            req.body.usuario || 'sistema', 'BACKUP_MANUAL', null, null,
            null, { caminho }, req.ip
        );

        res.json({ 
            sucesso: true, 
            mensagem: 'Backup realizado com sucesso.', 
            caminho: path.basename(caminho),
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });

    } catch (error) {
        logger.error('Erro ao gerar backup:', error);
        res.status(500).json({ erro: true, mensagem: 'Erro ao gerar backup: ' + error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 10. ✅ RELATÓRIO CONSOLIDADO (COM UNIDADE E LÓGICA CORRIGIDA)
// ───────────────────────────────────────────────────────────────────────

app.get('/api/relatorio/consolidado', authMiddleware, async (req, res) => {
    try {
        const { data_inicio, data_fim, unidade } = req.query;

        let filtroData = '';
        let params = [];

        if (data_inicio && data_fim) {
            filtroData = 'WHERE DATE(data_abertura) BETWEEN ? AND ?';
            params = [data_inicio, data_fim];
        }
        
        if (unidade) {
            filtroData += filtroData ? ' AND unidade LIKE ?' : 'WHERE unidade LIKE ?';
            params.push(`%${unidade}%`);
        }

        const caixas = await dbAll(
            `SELECT * FROM caixa_controle ${filtroData} ORDER BY data_abertura DESC`,
            params
        );

        const relatorio = [];

        for (const caixa of caixas) {
            const movimentos = await dbGet(
                `SELECT 
                    SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as total_credito,
                    SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as total_debito,
                    COUNT(*) as quantidade 
                 FROM movimentos WHERE id_caixa = ?`,
                [caixa.id]
            );

            // ✅ CALCULA SALDO CORRETO PARA O RELATÓRIO
            const saldoCalculado = calcularSaldo(caixa.saldo_inicial, movimentos.total_credito, movimentos.total_debito);

            relatorio.push({
                id: caixa.id,
                status: caixa.status,
                usuario_abertura: caixa.usuario_abertura,
                unidade: caixa.unidade,
                data_abertura: caixa.data_abertura,
                data_fechamento: caixa.data_fechamento,
                saldo_inicial: parseFloat(caixa.saldo_inicial.toFixed(2)),
                saldo_final: parseFloat((caixa.saldo_final || saldoCalculado).toFixed(2)),
                movimentacoes_credito: parseFloat((movimentos.total_credito || 0).toFixed(2)),
                movimentacoes_debito: parseFloat((movimentos.total_debito || 0).toFixed(2)),
                quantidade_lancamentos: movimentos.quantidade || 0
            });
        }

        res.json({
            sucesso: true,
            periodo: {
                inicio: data_inicio || 'Todos',
                fim: data_fim || 'Todos'
            },
            filtros: {
                unidade: unidade || 'Todas'
            },
            total_caixas: relatorio.length,
            dados: relatorio
        });

    } catch (error) {
        logger.error('Erro ao gerar relatório:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 11. EXPORTAR RELATÓRIO EM EXCEL
// ───────────────────────────────────────────────────────────────────────

app.get('/api/relatorio/exportar', authMiddleware, async (req, res) => {
    try {
        const { data_inicio, data_fim } = req.query;

        let filtro = 'WHERE 1=1';
        let params = [];

        if (data_inicio) {
            filtro += ' AND DATE(data_cadastro) >= ?';
            params.push(data_inicio);
        }
        if (data_fim) {
            filtro += ' AND DATE(data_cadastro) <= ?';
            params.push(data_fim);
        }

        const movimentos = await dbAll(
            `SELECT 
                requisicao as 'Requisição',
                data_cadastro as 'Data',
                usuario as 'Usuário',
                valor as 'Valor',
                tipo_transacao as 'Tipo',
                forma_pagamento as 'Forma Pagamento',
                descricao_transacao as 'Descrição',
                posto_coleta as 'Unidade/Posto'
             FROM movimentos ${filtro} ORDER BY data_cadastro DESC`,
            params
        );

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(movimentos);
        
        xlsx.utils.book_append_sheet(wb, ws, 'Movimentos');

        const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
        const filename = `relatorio_${timestamp}.xlsx`;
        const filepath = path.join(UPLOAD_FOLDER, filename);

        xlsx.writeFile(wb, filepath);

        res.download(filepath, filename, (err) => {
            if (err) logger.error('Erro ao enviar arquivo:', err);
            setTimeout(() => {
                if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            }, 60000);
        });

    } catch (error) {
        logger.error('Erro ao exportar relatório:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 12. AUDITORIA
// ───────────────────────────────────────────────────────────────────────

app.get('/api/auditoria', authMiddleware, async (req, res) => {
    try {
        const { pagina = 1, limite = 50, usuario, acao } = req.query;
        const offset = (pagina - 1) * limite;

        let query = 'SELECT * FROM auditoria WHERE 1=1';
        let params = [];

        if (usuario) {
            query += ' AND usuario LIKE ?';
            params.push(`%${usuario}%`);
        }
        if (acao) {
            query += ' AND acao = ?';
            params.push(acao);
        }

        const total = await dbGet(`SELECT COUNT(*) as total FROM (${query})`, params);

        query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limite), offset);

        const logs = await dbAll(query, params);

        res.json({
            sucesso: true,
            dados: logs,
            paginacao: {
                total: total.total,
                pagina_atual: parseInt(pagina),
                total_paginas: Math.ceil(total.total / limite)
            }
        });

    } catch (error) {
        logger.error('Erro ao consultar auditoria:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// AGENDAMENTOS (CRON)
// ═══════════════════════════════════════════════════════════════════════

cron.schedule('0 0 * * 3', async () => {
    logger.info('🔄 Iniciando backup automático...');
    try {
        await realizarBackup();
    } catch (error) {
        logger.error('Falha no backup automático:', error);
    }
});

// ═══════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════

process.on('SIGINT', () => {
    logger.info('🛑 Encerrando servidor...');
    db.close((err) => {
        if (err) logger.error('Erro ao fechar banco:', err);
        logger.info('✅ Banco de dados fechado.');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    logger.info('🛑 SIGTERM recebido, encerrando...');
    db.close(() => process.exit(0));
});

// ═══════════════════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                                                                       ║
║   🚀 SISTEMA DE CONTROLE DE CAIXA V5.0 - LÓGICA FINANCEIRA CORRETA   ║
║                                                                       ║
╠═══════════════════════════════════════════════════════════════════════╣
║                                                                       ║
║   📡 Servidor: http://localhost:${PORT}                                    ║
║   🔑 API Key: ${API_KEY.substring(0, 4)}****                                          ║
║   📦 Node: ${process.version}                                             ║
║   🌐 Interface: http://localhost:${PORT}                                   ║
║                                                                       ║
╠═══════════════════════════════════════════════════════════════════════╣
║                                                                       ║
║   ✅ CORREÇÕES V5.0:                                                 ║
║   • Saldo = Inicial + CRÉDITO - DÉBITO (lógica correta)             ║
║   • Campo UNIDADE obrigatório na abertura                            ║
║   • Detecção inteligente de forma de pagamento                       ║
║   • Valores negativos (-) = DÉBITO automático                        ║
║   • Formas: PIX, C.D, C.C, Transferência, Depósito                   ║
║   • Todos os cálculos de saldo corrigidos                            ║
║                                                                       ║
╚═══════════════════════════════════════════════════════════════════════╝
    `);
    
    logger.info('✅ Sistema V5.0 iniciado - Lógica financeira 100% corrigida!');
});
