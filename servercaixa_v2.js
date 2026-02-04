/**
 * ═══════════════════════════════════════════════════════════════════════
 * SISTEMA DE CONTROLE DE CAIXA V5.7 - CORREÇÕES CRÍTICAS
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * ✅ CORREÇÕES V5.7:
 * • CORRIGIDO: Edição de lançamentos (validação e update)
 * • CORRIGIDO: Exclusão de lançamentos (verificação de caixa)
 * • CORRIGIDO: Lançamento manual usa caixa da DATA do lançamento
 * • CORRIGIDO: Rate limiting removido para operações críticas
 * • MELHORADO: Validação de data em lançamentos
 * • ADICIONADO: API para desabilitar rate limit por API key
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
        unidade: Joi.string().min(2).max(100).required(),
        saldo_inicial_informado: Joi.number().optional(),
        data_abertura: Joi.string().optional()
    }),
    
    registrarMovimento: Joi.object({
        requisicao: Joi.string().allow('').optional(),
        data_cadastro: Joi.string().optional(),
        usuario: Joi.string().required(),
        valor: Joi.number().required(),
        tipo_transacao: Joi.string().valid('DEBITO', 'CREDITO').required(),
        forma_pagamento: Joi.string().valid('PIX', 'DINHEIRO', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'TRANSFERENCIA', 'DEPOSITO', 'OUTRO').required(),
        descricao_transacao: Joi.string().allow('').optional(),
        posto_coleta: Joi.string().allow('').optional(),
        unidade: Joi.string().optional()
    }),
    
    editarMovimento: Joi.object({
        requisicao: Joi.string().allow('').optional(),
        usuario: Joi.string().optional(),
        valor: Joi.number().optional(),
        tipo_transacao: Joi.string().valid('DEBITO', 'CREDITO').optional(),
        forma_pagamento: Joi.string().valid('PIX', 'DINHEIRO', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'TRANSFERENCIA', 'DEPOSITO', 'OUTRO').optional(),
        descricao_transacao: Joi.string().allow('').optional(),
        posto_coleta: Joi.string().allow('').optional(),
        motivo_edicao: Joi.string().required(),
        usuario_edicao: Joi.string().required()
    }),

    importarDados: Joi.object({
        usuario: Joi.string().optional(),
        usar_data_original: Joi.boolean().default(true),
        data_lancamento: Joi.string().optional()
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
// MIDDLEWARE - ORDEM IMPORTANTE!
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

app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ✅ RATE LIMITING APENAS PARA ROTAS GENÉRICAS (NÃO PARA OPERAÇÕES CRÍTICAS)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000, // Aumentado de 100 para 1000
    skip: (req) => {
        // Pula rate limiting se tiver API key válida
        return req.headers['x-api-key'] === API_KEY;
    },
    message: { erro: true, mensagem: 'Muitas requisições. Tente novamente mais tarde.' }
});

// Aplicar apenas em rotas de consulta genéricas
app.use('/api/auditoria', limiter);
app.use('/api/relatorio', limiter);

// ✅ UPLOAD SEM RATE LIMITING ESTRITO
const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100, // Aumentado de 20 para 100
    skip: (req) => req.headers['x-api-key'] === API_KEY,
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
        db.run(`
            CREATE TABLE IF NOT EXISTS caixa_controle (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario_abertura TEXT NOT NULL,
                unidade TEXT NOT NULL,
                data_abertura TEXT NOT NULL,
                data_fechamento TEXT,
                saldo_inicial REAL NOT NULL DEFAULT 0,
                saldo_final REAL,
                status TEXT NOT NULL DEFAULT 'ABERTO'
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS movimentos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                id_caixa INTEGER NOT NULL,
                requisicao TEXT,
                data_cadastro TEXT NOT NULL,
                usuario TEXT NOT NULL,
                valor REAL NOT NULL,
                tipo_transacao TEXT NOT NULL,
                forma_pagamento TEXT NOT NULL,
                descricao_transacao TEXT,
                posto_coleta TEXT,
                criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
                atualizado_em TEXT,
                FOREIGN KEY (id_caixa) REFERENCES caixa_controle(id)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS auditoria (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
                usuario TEXT,
                acao TEXT,
                detalhes TEXT,
                ip TEXT
            )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_movimentos_caixa ON movimentos(id_caixa)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_movimentos_data ON movimentos(data_cadastro)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_caixa_unidade ON caixa_controle(unidade)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_caixa_status ON caixa_controle(status)`);

        logger.info('✅ Tabelas e índices verificados/criados com sucesso.');
    });
}

// ═══════════════════════════════════════════════════════════════════════
// FUNÇÕES AUXILIARES DO BANCO
// ═══════════════════════════════════════════════════════════════════════

function dbRun(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function registrarAuditoria(usuario, acao, detalhes, ip) {
    try {
        await dbRun(
            'INSERT INTO auditoria (usuario, acao, detalhes, ip) VALUES (?, ?, ?, ?)',
            [usuario, acao, JSON.stringify(detalhes), ip]
        );
    } catch (error) {
        logger.error('Erro ao registrar auditoria:', error);
    }
}

function calcularSaldo(saldoInicial, totalCredito, totalDebito) {
    const inicial = parseFloat(saldoInicial) || 0;
    const credito = parseFloat(totalCredito) || 0;
    const debito = parseFloat(totalDebito) || 0;
    return inicial + credito - debito;
}

function converterData(valorData) {
    if (!valorData) return moment().format('YYYY-MM-DD HH:mm:ss');

    const str = String(valorData).trim();

    if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
        const m = moment(str, 'YYYY-MM-DD HH:mm:ss', true);
        return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : moment().format('YYYY-MM-DD HH:mm:ss');
    }

    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
        const m = moment(str, 'DD/MM/YYYY HH:mm:ss', true);
        return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : moment().format('YYYY-MM-DD HH:mm:ss');
    }

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
        const m = moment(str, 'DD/MM/YYYY', true);
        return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : moment().format('YYYY-MM-DD HH:mm:ss');
    }

    const m = moment(str);
    return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : moment().format('YYYY-MM-DD HH:mm:ss');
}

function detectarFormaPagamento(descricao) {
    if (!descricao) return 'OUTRO';
    
    const desc = descricao.toUpperCase();
    
    if (desc.includes('PIX')) return 'PIX';
    if (desc.includes('C.D') || desc.includes('CARTAO DEBITO') || desc.includes('DÉBITO')) return 'CARTAO_DEBITO';
    if (desc.includes('C.C') || desc.includes('CARTAO CREDITO') || desc.includes('CRÉDITO')) return 'CARTAO_CREDITO';
    if (desc.includes('TRANSFERENCIA') || desc.includes('TRANSFERÊNCIA')) return 'TRANSFERENCIA';
    if (desc.includes('DEPOSITO') || desc.includes('DEPÓSITO')) return 'DEPOSITO';
    if (desc.includes('DINHEIRO') || desc.includes('ESPECIE')) return 'DINHEIRO';
    
    return 'OUTRO';
}

// ✅ NOVA FUNÇÃO: Buscar ou criar caixa para uma data específica
async function buscarOuCriarCaixaParaData(unidade, dataLancamento, usuarioCriacao) {
    const dataFormatada = converterData(dataLancamento);
    const dataApenas = moment(dataFormatada).format('YYYY-MM-DD');

    // Busca caixa aberto ou fechado para esta data e unidade
    let caixa = await dbGet(
        `SELECT * FROM caixa_controle 
         WHERE unidade = ? AND DATE(data_abertura) = ? 
         ORDER BY data_abertura DESC LIMIT 1`,
        [unidade, dataApenas]
    );

    if (caixa) {
        // Se o caixa estiver fechado, reabre
        if (caixa.status === 'FECHADO') {
            await dbRun(
                'UPDATE caixa_controle SET status = "ABERTO" WHERE id = ?',
                [caixa.id]
            );
            logger.info(`Caixa ${caixa.id} reaberto para inserção de lançamento retroativo`);
            caixa.status = 'ABERTO';
        }
        return caixa;
    }

    // Se não existe, cria um novo caixa para esta data
    const result = await dbRun(
        `INSERT INTO caixa_controle (usuario_abertura, unidade, data_abertura, saldo_inicial, status) 
         VALUES (?, ?, ?, 0, 'ABERTO')`,
        [usuarioCriacao, unidade, dataFormatada]
    );

    logger.info(`Novo caixa ${result.id} criado automaticamente para ${dataApenas}`);

    return {
        id: result.id,
        unidade: unidade,
        data_abertura: dataFormatada,
        saldo_inicial: 0,
        status: 'ABERTO'
    };
}

// ═══════════════════════════════════════════════════════════════════════
// ROTAS DA API
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// 1. ✅ ABRIR CAIXA (COM DATA CUSTOMIZADA)
// ───────────────────────────────────────────────────────────────────────

app.post('/api/caixa/abrir', authMiddleware, async (req, res) => {
    try {
        const { error, value } = schemas.abrirCaixa.validate(req.body);
        if (error) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: `Dados inválidos: ${error.details[0].message}` 
            });
        }

        const { usuario, unidade, saldo_inicial_informado, data_abertura } = value;

        const dataAberturaFormatada = data_abertura 
            ? converterData(data_abertura) 
            : moment().format('YYYY-MM-DD HH:mm:ss');

        if (moment(dataAberturaFormatada).isAfter(moment())) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'A data de abertura não pode ser no futuro' 
            });
        }

        const caixaAbertoUnidade = await dbGet(
            'SELECT * FROM caixa_controle WHERE status = "ABERTO" AND unidade = ? ORDER BY data_abertura DESC LIMIT 1',
            [unidade]
        );

        if (caixaAbertoUnidade) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: `Já existe um caixa aberto para a unidade "${unidade}" (ID: ${caixaAbertoUnidade.id}) desde ${caixaAbertoUnidade.data_abertura}` 
            });
        }

        const caixaMesmaData = await dbGet(
            'SELECT * FROM caixa_controle WHERE unidade = ? AND DATE(data_abertura) = DATE(?) LIMIT 1',
            [unidade, dataAberturaFormatada]
        );

        if (caixaMesmaData) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: `Já existe um caixa para a unidade "${unidade}" na data ${moment(dataAberturaFormatada).format('DD/MM/YYYY')} (ID: ${caixaMesmaData.id})` 
            });
        }

        const saldoInicial = saldo_inicial_informado || 0;

        const result = await dbRun(
            `INSERT INTO caixa_controle (usuario_abertura, unidade, data_abertura, saldo_inicial, status) 
             VALUES (?, ?, ?, ?, 'ABERTO')`,
            [usuario, unidade, dataAberturaFormatada, saldoInicial]
        );

        await registrarAuditoria(usuario, 'ABERTURA_CAIXA', { 
            id_caixa: result.id, 
            unidade, 
            saldo_inicial: saldoInicial,
            data_abertura: dataAberturaFormatada,
            data_customizada: !!data_abertura
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: data_abertura 
                ? `Caixa aberto com sucesso para a unidade "${unidade}" na data ${moment(dataAberturaFormatada).format('DD/MM/YYYY HH:mm')}!`
                : `Caixa aberto com sucesso para a unidade "${unidade}"!`,
            dados: {
                id_caixa: result.id,
                usuario_abertura: usuario,
                unidade: unidade,
                data_abertura: dataAberturaFormatada,
                saldo_inicial: parseFloat(saldoInicial.toFixed(2)),
                data_customizada: !!data_abertura
            }
        });

    } catch (error) {
        logger.error('Erro ao abrir caixa:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 2. FECHAR CAIXA
// ───────────────────────────────────────────────────────────────────────

app.post('/api/caixa/fechar', authMiddleware, async (req, res) => {
    try {
        const { usuario, unidade } = req.body;
        
        if (!usuario) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Campo "usuario" é obrigatório' 
            });
        }

        let query = 'SELECT * FROM caixa_controle WHERE status = "ABERTO"';
        let params = [];

        if (unidade) {
            query += ' AND unidade = ?';
            params.push(unidade);
        }

        query += ' ORDER BY data_abertura DESC LIMIT 1';

        const caixaAberto = await dbGet(query, params);

        if (!caixaAberto) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: unidade 
                    ? `Nenhum caixa aberto para a unidade "${unidade}"` 
                    : 'Nenhum caixa aberto para fechar'
            });
        }

        const movimentos = await dbGet(
            `SELECT 
                SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as total_credito,
                SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as total_debito
             FROM movimentos WHERE id_caixa = ?`,
            [caixaAberto.id]
        );

        const saldoFinal = calcularSaldo(caixaAberto.saldo_inicial, movimentos.total_credito, movimentos.total_debito);
        const dataFechamento = moment().format('YYYY-MM-DD HH:mm:ss');

        await dbRun(
            'UPDATE caixa_controle SET saldo_final = ?, data_fechamento = ?, status = "FECHADO" WHERE id = ?',
            [saldoFinal, dataFechamento, caixaAberto.id]
        );

        await registrarAuditoria(usuario, 'FECHAMENTO_CAIXA', { 
            id_caixa: caixaAberto.id, 
            unidade: caixaAberto.unidade,
            saldo_final: saldoFinal 
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: `Caixa fechado com sucesso para a unidade "${caixaAberto.unidade}"!`,
            dados: {
                id_caixa: caixaAberto.id,
                unidade: caixaAberto.unidade,
                usuario_fechamento: usuario,
                data_fechamento: dataFechamento,
                saldo_inicial: parseFloat(caixaAberto.saldo_inicial.toFixed(2)),
                saldo_final: parseFloat(saldoFinal.toFixed(2)),
                movimentacoes_credito: parseFloat((movimentos.total_credito || 0).toFixed(2)),
                movimentacoes_debito: parseFloat((movimentos.total_debito || 0).toFixed(2))
            }
        });

    } catch (error) {
        logger.error('Erro ao fechar caixa:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 3. STATUS DO CAIXA
// ───────────────────────────────────────────────────────────────────────

app.get('/api/caixa/status', authMiddleware, async (req, res) => {
    try {
        const { unidade } = req.query;

        let query = 'SELECT * FROM caixa_controle WHERE status = "ABERTO"';
        let params = [];

        if (unidade) {
            query += ' AND unidade = ?';
            params.push(unidade);
        }

        query += ' ORDER BY data_abertura DESC LIMIT 1';

        const caixaAberto = await dbGet(query, params);

        if (!caixaAberto) {
            return res.json({
                sucesso: true,
                caixa_aberto: false,
                mensagem: unidade 
                    ? `Nenhum caixa aberto para a unidade "${unidade}"` 
                    : 'Nenhum caixa aberto no momento'
            });
        }

        const movimentos = await dbGet(
            `SELECT 
                SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as total_credito,
                SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as total_debito,
                COUNT(*) as quantidade
             FROM movimentos WHERE id_caixa = ?`,
            [caixaAberto.id]
        );

        const saldoAtual = calcularSaldo(caixaAberto.saldo_inicial, movimentos.total_credito, movimentos.total_debito);

        res.json({
            sucesso: true,
            caixa_aberto: true,
            dados: {
                id_caixa: caixaAberto.id,
                usuario_abertura: caixaAberto.usuario_abertura,
                unidade: caixaAberto.unidade,
                data_abertura: caixaAberto.data_abertura,
                saldo_inicial: parseFloat(caixaAberto.saldo_inicial.toFixed(2)),
                saldo_atual: parseFloat(saldoAtual.toFixed(2)),
                movimentacoes_credito: parseFloat((movimentos.total_credito || 0).toFixed(2)),
                movimentacoes_debito: parseFloat((movimentos.total_debito || 0).toFixed(2)),
                quantidade_lancamentos: movimentos.quantidade || 0
            }
        });

    } catch (error) {
        logger.error('Erro ao consultar status do caixa:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 4. LISTAR CAIXAS POR UNIDADE
// ───────────────────────────────────────────────────────────────────────

app.get('/api/caixa/unidade/:unidade', authMiddleware, async (req, res) => {
    try {
        const { unidade } = req.params;
        const { status, data_inicio, data_fim } = req.query;

        let query = 'SELECT * FROM caixa_controle WHERE unidade = ?';
        let params = [unidade];

        if (status) {
            query += ' AND status = ?';
            params.push(status.toUpperCase());
        }

        if (data_inicio) {
            query += ' AND DATE(data_abertura) >= ?';
            params.push(data_inicio);
        }

        if (data_fim) {
            query += ' AND DATE(data_abertura) <= ?';
            params.push(data_fim);
        }

        query += ' ORDER BY data_abertura DESC';

        const caixas = await dbAll(query, params);

        if (caixas.length === 0) {
            return res.json({
                sucesso: true,
                mensagem: `Nenhum caixa encontrado para a unidade "${unidade}"`,
                dados: []
            });
        }

        const caixasCompletos = await Promise.all(caixas.map(async (caixa) => {
            const movimentos = await dbGet(
                `SELECT 
                    SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as total_credito,
                    SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as total_debito,
                    COUNT(*) as quantidade
                 FROM movimentos WHERE id_caixa = ?`,
                [caixa.id]
            );

            const saldoCalculado = calcularSaldo(caixa.saldo_inicial, movimentos.total_credito, movimentos.total_debito);

            return {
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
            };
        }));

        res.json({
            sucesso: true,
            unidade: unidade,
            total_caixas: caixasCompletos.length,
            dados: caixasCompletos
        });

    } catch (error) {
        logger.error('Erro ao listar caixas por unidade:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 5. LISTAR TODOS OS CAIXAS FECHADOS COM LANÇAMENTOS
// ───────────────────────────────────────────────────────────────────────

app.get('/api/caixa/fechados', authMiddleware, async (req, res) => {
    try {
        const { unidade, data_inicio, data_fim, incluir_lancamentos = 'true' } = req.query;

        let query = 'SELECT * FROM caixa_controle WHERE status = "FECHADO"';
        let params = [];

        if (unidade) {
            query += ' AND unidade = ?';
            params.push(unidade);
        }

        if (data_inicio) {
            query += ' AND DATE(data_fechamento) >= ?';
            params.push(data_inicio);
        }

        if (data_fim) {
            query += ' AND DATE(data_fechamento) <= ?';
            params.push(data_fim);
        }

        query += ' ORDER BY data_fechamento DESC';

        const caixas = await dbAll(query, params);

        if (caixas.length === 0) {
            return res.json({
                sucesso: true,
                mensagem: 'Nenhum caixa fechado encontrado',
                dados: []
            });
        }

        const caixasCompletos = await Promise.all(caixas.map(async (caixa) => {
            const resumo = await dbGet(
                `SELECT 
                    SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as total_credito,
                    SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as total_debito,
                    COUNT(*) as quantidade
                 FROM movimentos WHERE id_caixa = ?`,
                [caixa.id]
            );

            let lancamentos = [];
            if (incluir_lancamentos === 'true') {
                lancamentos = await dbAll(
                    'SELECT * FROM movimentos WHERE id_caixa = ? ORDER BY data_cadastro DESC',
                    [caixa.id]
                );
            }

            return {
                id: caixa.id,
                unidade: caixa.unidade,
                usuario_abertura: caixa.usuario_abertura,
                data_abertura: caixa.data_abertura,
                data_fechamento: caixa.data_fechamento,
                saldo_inicial: parseFloat(caixa.saldo_inicial.toFixed(2)),
                saldo_final: parseFloat((caixa.saldo_final || 0).toFixed(2)),
                resumo: {
                    total_credito: parseFloat((resumo.total_credito || 0).toFixed(2)),
                    total_debito: parseFloat((resumo.total_debito || 0).toFixed(2)),
                    quantidade_lancamentos: resumo.quantidade || 0
                },
                lancamentos: incluir_lancamentos === 'true' ? lancamentos : undefined
            };
        }));

        res.json({
            sucesso: true,
            total_caixas_fechados: caixasCompletos.length,
            filtros: {
                unidade: unidade || 'Todas',
                data_inicio: data_inicio || 'Todas',
                data_fim: data_fim || 'Todas'
            },
            dados: caixasCompletos
        });

    } catch (error) {
        logger.error('Erro ao listar caixas fechados:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 6. LISTAR TODOS OS LANÇAMENTOS POR UNIDADE
// ───────────────────────────────────────────────────────────────────────

app.get('/api/lancamentos/unidade/:unidade', authMiddleware, async (req, res) => {
    try {
        const { unidade } = req.params;
        const { data_inicio, data_fim, tipo, pagina = 1, limite = 100 } = req.query;
        const offset = (pagina - 1) * limite;

        const caixas = await dbAll(
            'SELECT id FROM caixa_controle WHERE unidade = ?',
            [unidade]
        );

        if (caixas.length === 0) {
            return res.json({
                sucesso: true,
                mensagem: `Nenhum caixa encontrado para a unidade "${unidade}"`,
                dados: [],
                resumo: {
                    total_credito: 0,
                    total_debito: 0,
                    saldo: 0,
                    quantidade: 0
                }
            });
        }

        const idsCaixas = caixas.map(c => c.id);
        const placeholders = idsCaixas.map(() => '?').join(',');

        let query = `SELECT m.*, c.unidade 
                     FROM movimentos m 
                     INNER JOIN caixa_controle c ON m.id_caixa = c.id 
                     WHERE m.id_caixa IN (${placeholders})`;
        let params = [...idsCaixas];

        if (data_inicio) {
            query += ' AND DATE(m.data_cadastro) >= ?';
            params.push(data_inicio);
        }
        if (data_fim) {
            query += ' AND DATE(m.data_cadastro) <= ?';
            params.push(data_fim);
        }
        if (tipo) {
            query += ' AND m.tipo_transacao = ?';
            params.push(tipo);
        }

        const resumo = await dbGet(
            `SELECT 
                SUM(CASE WHEN tipo_transacao = 'CREDITO' THEN valor ELSE 0 END) as total_credito,
                SUM(CASE WHEN tipo_transacao = 'DEBITO' THEN valor ELSE 0 END) as total_debito,
                COUNT(*) as quantidade
             FROM movimentos WHERE id_caixa IN (${placeholders})`,
            idsCaixas
        );

        const total = await dbGet(`SELECT COUNT(*) as total FROM (${query})`, params);

        query += ' ORDER BY m.data_cadastro DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limite), offset);

        const lancamentos = await dbAll(query, params);

        const saldo = (resumo.total_credito || 0) - (resumo.total_debito || 0);

        res.json({
            sucesso: true,
            unidade: unidade,
            dados: lancamentos,
            resumo: {
                total_credito: parseFloat((resumo.total_credito || 0).toFixed(2)),
                total_debito: parseFloat((resumo.total_debito || 0).toFixed(2)),
                saldo: parseFloat(saldo.toFixed(2)),
                quantidade: resumo.quantidade || 0
            },
            paginacao: {
                total: total.total,
                pagina_atual: parseInt(pagina),
                total_paginas: Math.ceil(total.total / limite)
            }
        });

    } catch (error) {
        logger.error('Erro ao listar lançamentos por unidade:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 7. ✅ REGISTRAR MOVIMENTO (CORRIGIDO - USA CAIXA DA DATA DO LANÇAMENTO)
// ───────────────────────────────────────────────────────────────────────

app.post('/api/movimento', authMiddleware, async (req, res) => {
    try {
        const { error, value } = schemas.registrarMovimento.validate(req.body);
        if (error) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: `Dados inválidos: ${error.details[0].message}` 
            });
        }

        const { unidade } = value;

        if (!unidade) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Campo "unidade" é obrigatório para registrar movimento' 
            });
        }

        // ✅ CORREÇÃO: Usa a data do lançamento para buscar/criar o caixa correto
        const dataCadastro = value.data_cadastro || moment().format('YYYY-MM-DD HH:mm:ss');
        const dataFormatada = converterData(dataCadastro);

        // Busca ou cria caixa para a data do lançamento
        const caixa = await buscarOuCriarCaixaParaData(unidade, dataFormatada, value.usuario);

        const result = await dbRun(
            `INSERT INTO movimentos 
             (id_caixa, requisicao, data_cadastro, usuario, valor, tipo_transacao, forma_pagamento, descricao_transacao, posto_coleta) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                caixa.id,
                value.requisicao || '',
                dataFormatada,
                value.usuario,
                Math.abs(value.valor),
                value.tipo_transacao,
                value.forma_pagamento,
                value.descricao_transacao || '',
                value.posto_coleta || ''
            ]
        );

        await registrarAuditoria(value.usuario, 'REGISTRO_MOVIMENTO', {
            id_movimento: result.id,
            id_caixa: caixa.id,
            tipo: value.tipo_transacao,
            valor: value.valor,
            data_lancamento: dataFormatada
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: 'Movimento registrado com sucesso!',
            dados: {
                id_movimento: result.id,
                id_caixa: caixa.id,
                unidade: caixa.unidade,
                data_caixa: caixa.data_abertura,
                data_lancamento: dataFormatada
            }
        });

    } catch (error) {
        logger.error('Erro ao registrar movimento:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 8. LISTAR MOVIMENTOS
// ───────────────────────────────────────────────────────────────────────

app.get('/api/movimentos', authMiddleware, async (req, res) => {
    try {
        const { data_inicio, data_fim, tipo, pagina = 1, limite = 50 } = req.query;
        const offset = (pagina - 1) * limite;

        let query = 'SELECT * FROM movimentos WHERE 1=1';
        let params = [];

        if (data_inicio) {
            query += ' AND DATE(data_cadastro) >= ?';
            params.push(data_inicio);
        }
        if (data_fim) {
            query += ' AND DATE(data_cadastro) <= ?';
            params.push(data_fim);
        }
        if (tipo) {
            query += ' AND tipo_transacao = ?';
            params.push(tipo);
        }

        const total = await dbGet(`SELECT COUNT(*) as total FROM (${query})`, params);

        query += ' ORDER BY data_cadastro DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limite), offset);

        const movimentos = await dbAll(query, params);

        res.json({
            sucesso: true,
            dados: movimentos,
            paginacao: {
                total: total.total,
                pagina_atual: parseInt(pagina),
                total_paginas: Math.ceil(total.total / limite)
            }
        });

    } catch (error) {
        logger.error('Erro ao listar movimentos:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 9. ✅ EDITAR MOVIMENTO (CORRIGIDO)
// ───────────────────────────────────────────────────────────────────────

app.put('/api/movimento/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { error, value } = schemas.editarMovimento.validate(req.body);
        
        if (error) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: `Dados inválidos: ${error.details[0].message}` 
            });
        }

        const movimento = await dbGet('SELECT * FROM movimentos WHERE id = ?', [id]);
        if (!movimento) {
            return res.status(404).json({ 
                erro: true, 
                mensagem: 'Movimento não encontrado' 
            });
        }

        // ✅ Campos que podem ser editados
        const camposAtualizaveis = ['requisicao', 'usuario', 'valor', 'tipo_transacao', 
                                    'forma_pagamento', 'descricao_transacao', 'posto_coleta'];
        
        const updates = [];
        const params = [];

        camposAtualizaveis.forEach(campo => {
            if (value[campo] !== undefined) {
                updates.push(`${campo} = ?`);
                // ✅ Se for valor, garante que seja absoluto
                params.push(campo === 'valor' ? Math.abs(value[campo]) : value[campo]);
            }
        });

        if (updates.length === 0) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Nenhum campo para atualizar' 
            });
        }

        updates.push('atualizado_em = ?');
        params.push(moment().format('YYYY-MM-DD HH:mm:ss'));
        params.push(id);

        await dbRun(
            `UPDATE movimentos SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        await registrarAuditoria(value.usuario_edicao, 'EDICAO_MOVIMENTO', {
            id_movimento: id,
            motivo: value.motivo_edicao,
            campos_alterados: camposAtualizaveis.filter(c => value[c] !== undefined),
            valores_antigos: movimento,
            valores_novos: value
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: 'Movimento atualizado com sucesso!',
            dados: {
                id_movimento: id,
                campos_atualizados: camposAtualizaveis.filter(c => value[c] !== undefined)
            }
        });

    } catch (error) {
        logger.error('Erro ao editar movimento:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 10. ✅ DELETAR MOVIMENTO (CORRIGIDO)
// ───────────────────────────────────────────────────────────────────────

app.delete('/api/movimento/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { usuario, motivo } = req.body;

        if (!usuario || !motivo) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Campos "usuario" e "motivo" são obrigatórios' 
            });
        }

        const movimento = await dbGet('SELECT * FROM movimentos WHERE id = ?', [id]);
        if (!movimento) {
            return res.status(404).json({ 
                erro: true, 
                mensagem: 'Movimento não encontrado' 
            });
        }

        // ✅ Verifica se o caixa ainda existe
        const caixa = await dbGet('SELECT * FROM caixa_controle WHERE id = ?', [movimento.id_caixa]);
        
        await dbRun('DELETE FROM movimentos WHERE id = ?', [id]);

        await registrarAuditoria(usuario, 'EXCLUSAO_MOVIMENTO', {
            id_movimento: id,
            id_caixa: movimento.id_caixa,
            unidade: caixa ? caixa.unidade : 'N/A',
            motivo: motivo,
            movimento_excluido: movimento
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: 'Movimento deletado com sucesso!',
            dados: {
                id_movimento: id,
                id_caixa: movimento.id_caixa,
                valor_excluido: movimento.valor,
                tipo_excluido: movimento.tipo_transacao
            }
        });

    } catch (error) {
        logger.error('Erro ao deletar movimento:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 11. IMPORTAR EXCEL (USA DATA ORIGINAL)
// ───────────────────────────────────────────────────────────────────────

app.post('/api/importar', authMiddleware, uploadLimiter, upload.single('arquivo'), async (req, res) => {
    let importados = 0;
    let erros = [];

    try {
        if (!req.file) {
            logger.error('Nenhum arquivo foi enviado na requisição');
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Nenhum arquivo foi enviado. Por favor, selecione um arquivo Excel (.xlsx ou .xls)' 
            });
        }

        logger.info(`Arquivo recebido: ${req.file.originalname} (${req.file.size} bytes)`);

        const { error, value } = schemas.importarDados.validate(req.body);
        if (error) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ 
                erro: true, 
                mensagem: `Dados inválidos: ${error.details[0].message}` 
            });
        }

        const { usar_data_original = true, data_lancamento, unidade } = value;

        if (!unidade) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Campo "unidade" é obrigatório para importação' 
            });
        }

        let workbook;
        try {
            workbook = xlsx.readFile(req.file.path);
            logger.info(`Planilha lida com sucesso. Sheets disponíveis: ${workbook.SheetNames.join(', ')}`);
        } catch (excelError) {
            logger.error('Erro ao ler arquivo Excel:', excelError);
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ 
                erro: true, 
                mensagem: `Arquivo Excel inválido ou corrompido: ${excelError.message}` 
            });
        }

        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const dados = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

        logger.info(`Total de linhas encontradas: ${dados.length}`);

        if (dados.length === 0) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Arquivo vazio ou sem dados válidos' 
            });
        }

        if (dados.length > 0) {
            logger.info('Headers detectados: ' + JSON.stringify(Object.keys(dados[0])));
        }

        let duplicatas = 0;

        for (let i = 0; i < dados.length; i++) {
            const linha = dados[i];
            const numeroLinha = i + 2;

            try {
                const requisicao  = String(linha['Requisicao']  || '').trim();
                const descricao   = String(linha['DescricaoTransacao'] || '').trim();
                const usuario     = String(linha['Usuario']     || 'Sistema').trim();
                const posto       = String(linha['PostoColeta'] || '').trim();
                const nomeCompleto = [linha['Nome'] || '', linha['Sobrenome'] || ''].join(' ').trim();

                const valorRaw =
                    linha['Pagamento'] !== undefined && linha['Pagamento'] !== '' ? linha['Pagamento'] :
                    linha['TotalPago'] !== undefined && linha['TotalPago'] !== '' ? linha['TotalPago'] : 0;

                let dataCadastro;
                if (!usar_data_original && data_lancamento) {
                    dataCadastro = converterData(data_lancamento);
                } else {
                    dataCadastro = converterData(linha['DataTransacao'] || linha['DataCadastro']);
                }

                let valor = parseFloat(String(valorRaw).replace(/[^\d.,-]/g, '').replace(',', '.'));

                if (isNaN(valor) || valor === 0) {
                    logger.warn(`Linha ${numeroLinha}: valor zerado/inválido "${valorRaw}" — ignorada`);
                    continue;
                }

                if (requisicao !== '') {
                    const existe = await dbGet(
                        `SELECT id FROM movimentos
                         WHERE requisicao = ? AND valor = ? AND data_cadastro = ?
                         LIMIT 1`,
                        [requisicao, Math.abs(valor), dataCadastro]
                    );
                    if (existe) {
                        logger.warn(`Linha ${numeroLinha}: duplicata (req=${requisicao}) — ignorada`);
                        duplicatas++;
                        continue;
                    }
                }

                let tipoTransacao = 'CREDITO';
                if (valor < 0) {
                    tipoTransacao = 'DEBITO';
                    valor = Math.abs(valor);
                } else {
                    const tipoMov = String(linha['TipoMovimento'] || '').trim().toUpperCase();
                    if (['DEBITO','DÉBITO','D'].includes(tipoMov)) {
                        tipoTransacao = 'DEBITO';
                    } else if (['CREDITO','CRÉDITO','C'].includes(tipoMov)) {
                        tipoTransacao = 'CREDITO';
                    } else {
                        const du = descricao.toUpperCase();
                        if (du.includes('SAÍDA') || du.includes('DESPESA') || du.includes('DÉBITO')) {
                            tipoTransacao = 'DEBITO';
                        }
                    }
                }

                const formaPagamento = detectarFormaPagamento(descricao);

                let descricaoFinal = descricao;
                if (nomeCompleto && !descricao.toUpperCase().includes(nomeCompleto.toUpperCase())) {
                    descricaoFinal = nomeCompleto + (descricao ? ' - ' + descricao : '');
                }

                // ✅ Busca ou cria caixa para a data do lançamento
                const caixa = await buscarOuCriarCaixaParaData(unidade, dataCadastro, usuario);

                await dbRun(
                    `INSERT INTO movimentos 
                     (id_caixa, requisicao, data_cadastro, usuario, valor, tipo_transacao, forma_pagamento, descricao_transacao, posto_coleta) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        caixa.id,
                        requisicao,
                        dataCadastro,
                        usuario,
                        valor,
                        tipoTransacao,
                        formaPagamento,
                        descricaoFinal,
                        posto
                    ]
                );

                importados++;
                logger.info(`Linha ${numeroLinha} importada: valor=${valor} tipo=${tipoTransacao} data=${dataCadastro} caixa=${caixa.id}`);

            } catch (erroLinha) {
                logger.error(`Erro na linha ${numeroLinha}:`, erroLinha);
                erros.push(`Linha ${numeroLinha}: ${erroLinha.message}`);
            }
        }

        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        await registrarAuditoria(req.body.usuario || 'Sistema', 'IMPORTACAO_EXCEL', {
            arquivo: req.file.originalname,
            importados: importados,
            unidade: unidade,
            usar_data_original: usar_data_original,
            erros: erros.length
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: `Importação concluída! ${importados} lançamento(s) importado(s) para a unidade "${unidade}".${duplicatas > 0 ? ' ' + duplicatas + ' duplicata(s) ignorada(s).' : ''}`,
            dados: {
                unidade: unidade,
                importados: importados,
                duplicatas_ignoradas: duplicatas,
                erros: erros.length,
                detalhes_erros: erros.slice(0, 10),
                modo_data: usar_data_original ? 'Data original dos lançamentos' : 'Data customizada'
            }
        });

    } catch (error) {
        logger.error('Erro geral na importação:', error);
        
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({ 
            erro: true, 
            mensagem: `Erro ao processar importação: ${error.message}`,
            detalhes: {
                importados: importados,
                erros: erros.length,
                erro_detalhado: error.stack
            }
        });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 12. CLEANUP
// ───────────────────────────────────────────────────────────────────────

app.post('/api/cleanup', authMiddleware, async (req, res) => {
    try {
        const { confirmar } = req.body;

        if (confirmar !== true) {
            return res.status(400).json({
                erro: true,
                mensagem: 'Envie { "confirmar": true } no corpo para executar o cleanup.'
            });
        }

        const duplicatas = await dbAll(
            `SELECT id FROM movimentos
             WHERE id NOT IN (
                 SELECT MIN(id) FROM movimentos
                 GROUP BY id_caixa, requisicao, valor, data_cadastro, tipo_transacao
             )`
        );

        const idsParaRemover = duplicatas.map(r => r.id);

        if (idsParaRemover.length === 0) {
            return res.json({ sucesso: true, mensagem: 'Nenhuma duplicata encontrada.', removidos: 0 });
        }

        const placeholders = idsParaRemover.map(() => '?').join(',');
        await dbRun(`DELETE FROM movimentos WHERE id IN (${placeholders})`, idsParaRemover);

        await registrarAuditoria(req.body.usuario || 'Sistema', 'CLEANUP_DUPLICATAS', {
            ids_removidos: idsParaRemover,
            quantidade: idsParaRemover.length
        }, req.ip);

        logger.info(`Cleanup: ${idsParaRemover.length} duplicata(s) removida(s). IDs: ${idsParaRemover.join(',')}`);

        res.json({
            sucesso: true,
            mensagem: `Cleanup concluído. ${idsParaRemover.length} duplicata(s) removida(s).`,
            dados: {
                removidos: idsParaRemover.length,
                ids_removidos: idsParaRemover
            }
        });

    } catch (error) {
        logger.error('Erro no cleanup:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 13. BACKUP
// ───────────────────────────────────────────────────────────────────────

async function realizarBackup() {
    return new Promise((resolve, reject) => {
        const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
        const backupPath = path.join(BACKUP_FOLDER, `backup_${timestamp}.db`);

        const readStream = fs.createReadStream(DB_PATH);
        const writeStream = fs.createWriteStream(backupPath);

        readStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', () => {
            logger.info(`✅ Backup criado: ${backupPath}`);
            resolve(backupPath);
        });

        readStream.pipe(writeStream);
    });
}

app.post('/api/backup', authMiddleware, async (req, res) => {
    try {
        const backupPath = await realizarBackup();
        
        await registrarAuditoria(req.body.usuario || 'Sistema', 'BACKUP_MANUAL', {
            arquivo: path.basename(backupPath)
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: 'Backup realizado com sucesso!',
            arquivo: path.basename(backupPath)
        });

    } catch (error) {
        logger.error('Erro ao realizar backup:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 14. RELATÓRIOS
// ───────────────────────────────────────────────────────────────────────

app.get('/api/relatorio', authMiddleware, async (req, res) => {
    try {
        const { data_inicio, data_fim, unidade } = req.query;

        let filtro = 'WHERE 1=1';
        let params = [];

        if (data_inicio) {
            filtro += ' AND DATE(data_abertura) >= ?';
            params.push(data_inicio);
        }
        if (data_fim) {
            filtro += ' AND DATE(data_abertura) <= ?';
            params.push(data_fim);
        }
        if (unidade) {
            filtro += ' AND unidade = ?';
            params.push(unidade);
        }

        const caixas = await dbAll(
            `SELECT * FROM caixa_controle ${filtro} ORDER BY data_abertura DESC`,
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
// 15. EXPORTAR RELATÓRIO
// ───────────────────────────────────────────────────────────────────────

app.get('/api/relatorio/exportar', authMiddleware, async (req, res) => {
    try {
        const { data_inicio, data_fim, unidade } = req.query;

        let filtro = 'WHERE 1=1';
        let params = [];

        if (data_inicio) {
            filtro += ' AND DATE(m.data_cadastro) >= ?';
            params.push(data_inicio);
        }
        if (data_fim) {
            filtro += ' AND DATE(m.data_cadastro) <= ?';
            params.push(data_fim);
        }
        if (unidade) {
            filtro += ' AND c.unidade = ?';
            params.push(unidade);
        }

        const movimentos = await dbAll(
            `SELECT 
                m.requisicao as 'Requisição',
                m.data_cadastro as 'Data',
                m.usuario as 'Usuário',
                m.valor as 'Valor',
                m.tipo_transacao as 'Tipo',
                m.forma_pagamento as 'Forma Pagamento',
                m.descricao_transacao as 'Descrição',
                m.posto_coleta as 'Posto',
                c.unidade as 'Unidade'
             FROM movimentos m
             INNER JOIN caixa_controle c ON m.id_caixa = c.id
             ${filtro} ORDER BY m.data_cadastro DESC`,
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
// 16. AUDITORIA
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
// TRATAMENTO DE ERROS
// ═══════════════════════════════════════════════════════════════════════

app.use((req, res) => {
    res.status(404).json({
        erro: true,
        mensagem: `Rota não encontrada: ${req.method} ${req.path}`,
        rotas_disponiveis: [
            'POST /api/caixa/abrir (✅ COM data_abertura OPCIONAL)',
            'POST /api/caixa/fechar',
            'GET /api/caixa/status',
            'GET /api/caixa/unidade/:unidade',
            'GET /api/caixa/fechados',
            'GET /api/lancamentos/unidade/:unidade',
            'POST /api/movimento (✅ CORRIGIDO - usa caixa da data)',
            'GET /api/movimentos',
            'PUT /api/movimento/:id (✅ CORRIGIDO)',
            'DELETE /api/movimento/:id (✅ CORRIGIDO)',
            'POST /api/importar',
            'POST /api/cleanup',
            'POST /api/backup',
            'GET /api/relatorio',
            'GET /api/relatorio/exportar',
            'GET /api/auditoria'
        ]
    });
});

app.use((err, req, res, next) => {
    logger.error('Erro não tratado:', err);
    
    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            erro: true,
            mensagem: `Erro no upload: ${err.message}`,
            tipo: 'MULTER_ERROR',
            campo: err.field
        });
    }
    
    res.status(500).json({
        erro: true,
        mensagem: err.message || 'Erro interno do servidor',
        tipo: err.name || 'INTERNAL_ERROR',
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// ═══════════════════════════════════════════════════════════════════════
// AGENDAMENTOS
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
║   🚀 SISTEMA DE CONTROLE DE CAIXA V5.7 - CORREÇÕES CRÍTICAS         ║
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
║   ✅ CORREÇÕES V5.7:                                                 ║
║   • Lançamento manual usa CAIXA DA DATA DO LANÇAMENTO                ║
║   • Edição de lançamentos CORRIGIDA                                  ║
║   • Exclusão de lançamentos CORRIGIDA                                ║
║   • Rate limiting REMOVIDO para operações críticas                   ║
║   • Rate limiting com skip para API key válida                       ║
║   • Criação automática de caixa para datas retroativas               ║
║                                                                       ║
╚═══════════════════════════════════════════════════════════════════════╝
    `);
    
    logger.info('✅ Sistema V5.7 iniciado - Todas as correções aplicadas!');
});
    
    logger.info('✅ Sistema V5.6 iniciado - Data Customizada na Abertura!');
});


