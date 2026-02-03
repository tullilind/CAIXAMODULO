/**
 * ═══════════════════════════════════════════════════════════════════════
 * SISTEMA DE CONTROLE DE CAIXA V5.4 - DATAS + ANTI-DUPLICATA + CLEANUP
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * ✅ CORREÇÕES V5.4:
 * • Datas DD/MM/YYYY HH:mm:ss do Excel convertidas corretamente
 * • Migration: coluna 'detalhes' adicionada à auditoria se não existir
 * • Anti-duplicata na importação (Requisicao + valor + data)
 * • Endpoint POST /api/cleanup para remover duplicatas existentes
 * • Linhas com valor 0 ignoradas na importação
 * • Headers mapeados com nomes reais do Excel
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
        unidade: Joi.string().min(3).max(100).required(),
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
// MIDDLEWARE - ORDEM IMPORTANTE!
// ═══════════════════════════════════════════════════════════════════════

// 1. Helmet (segurança)
app.use(helmet({ contentSecurityPolicy: false }));

// 2. Compression
app.use(compression());

// 3. CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));

// 4. Body parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 5. ✅ GARANTIR QUE TODAS AS RESPOSTAS SEJAM JSON
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

// 6. Arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// 7. Rate limiters
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

// 8. Autenticação
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

// 9. Logging de requisições
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

        // ── MIGRATION V5.4: adiciona coluna 'detalhes' na auditoria se não existir ──
        db.run(`PRAGMA table_info(auditoria)`, (err, cols) => {
            if (err) { logger.error('Erro PRAGMA auditoria:', err); return; }
            const nomes = (cols || []).map(c => c.name);
            if (!nomes.includes('detalhes')) {
                db.run(`ALTER TABLE auditoria ADD COLUMN detalhes TEXT`, (err2) => {
                    if (err2) logger.error('Erro ALTER auditoria:', err2);
                    else      logger.info('✅ Migration V5.4: coluna "detalhes" adicionada.');
                });
            }
        });

        logger.info('✅ Tabelas verificadas/criadas com sucesso.');
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

// ✅ FUNÇÃO PARA CALCULAR SALDO CORRETO
function calcularSaldo(saldoInicial, totalCredito, totalDebito) {
    const inicial = parseFloat(saldoInicial) || 0;
    const credito = parseFloat(totalCredito) || 0;
    const debito = parseFloat(totalDebito) || 0;
    return inicial + credito - debito;
}

// ✅ FUNÇÃO PARA CONVERTER DATA do Excel (DD/MM/YYYY HH:mm:ss → YYYY-MM-DD HH:mm:ss)
function converterData(valorData) {
    if (!valorData) return moment().format('YYYY-MM-DD HH:mm:ss');

    const str = String(valorData).trim();

    // Se já está no formato ISO (YYYY-MM-DD ...), usa direto
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
        const m = moment(str, 'YYYY-MM-DD HH:mm:ss', true);
        return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : moment().format('YYYY-MM-DD HH:mm:ss');
    }

    // Formato brasileiro: DD/MM/YYYY HH:mm:ss
    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
        const m = moment(str, 'DD/MM/YYYY HH:mm:ss', true);
        return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : moment().format('YYYY-MM-DD HH:mm:ss');
    }

    // Formato brasileiro sem hora: DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
        const m = moment(str, 'DD/MM/YYYY', true);
        return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : moment().format('YYYY-MM-DD HH:mm:ss');
    }

    // Tentativa genérica com moment
    const m = moment(str);
    return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : moment().format('YYYY-MM-DD HH:mm:ss');
}

// ✅ FUNÇÃO PARA DETECTAR FORMA DE PAGAMENTO PELA DESCRIÇÃO
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

// ═══════════════════════════════════════════════════════════════════════
// ROTAS DA API
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// 1. ABRIR CAIXA
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

        const { usuario, unidade, saldo_inicial_informado } = value;

        const caixaAberto = await dbGet(
            'SELECT * FROM caixa_controle WHERE status = "ABERTO" ORDER BY data_abertura DESC LIMIT 1'
        );

        if (caixaAberto) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: `Já existe um caixa aberto (ID: ${caixaAberto.id}) desde ${caixaAberto.data_abertura}` 
            });
        }

        const dataAbertura = moment().format('YYYY-MM-DD HH:mm:ss');
        const saldoInicial = saldo_inicial_informado || 0;

        const result = await dbRun(
            `INSERT INTO caixa_controle (usuario_abertura, unidade, data_abertura, saldo_inicial, status) 
             VALUES (?, ?, ?, ?, 'ABERTO')`,
            [usuario, unidade, dataAbertura, saldoInicial]
        );

        await registrarAuditoria(usuario, 'ABERTURA_CAIXA', { 
            id_caixa: result.id, 
            unidade, 
            saldo_inicial: saldoInicial 
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: 'Caixa aberto com sucesso!',
            dados: {
                id_caixa: result.id,
                usuario_abertura: usuario,
                unidade: unidade,
                data_abertura: dataAbertura,
                saldo_inicial: parseFloat(saldoInicial.toFixed(2))
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
        const { usuario } = req.body;
        if (!usuario) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Campo "usuario" é obrigatório' 
            });
        }

        const caixaAberto = await dbGet(
            'SELECT * FROM caixa_controle WHERE status = "ABERTO" ORDER BY data_abertura DESC LIMIT 1'
        );

        if (!caixaAberto) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Nenhum caixa aberto para fechar' 
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
            saldo_final: saldoFinal 
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: 'Caixa fechado com sucesso!',
            dados: {
                id_caixa: caixaAberto.id,
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
        const caixaAberto = await dbGet(
            'SELECT * FROM caixa_controle WHERE status = "ABERTO" ORDER BY data_abertura DESC LIMIT 1'
        );

        if (!caixaAberto) {
            return res.json({
                sucesso: true,
                caixa_aberto: false,
                mensagem: 'Nenhum caixa aberto no momento'
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
// 4. REGISTRAR MOVIMENTO
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

        const caixaAberto = await dbGet(
            'SELECT id FROM caixa_controle WHERE status = "ABERTO" ORDER BY data_abertura DESC LIMIT 1'
        );

        if (!caixaAberto) {
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Nenhum caixa aberto. Abra um caixa antes de registrar movimentos.' 
            });
        }

        const dataCadastro = value.data_cadastro || moment().format('YYYY-MM-DD HH:mm:ss');

        const result = await dbRun(
            `INSERT INTO movimentos 
             (id_caixa, requisicao, data_cadastro, usuario, valor, tipo_transacao, forma_pagamento, descricao_transacao, posto_coleta) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                caixaAberto.id,
                value.requisicao || '',
                dataCadastro,
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
            tipo: value.tipo_transacao,
            valor: value.valor
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: 'Movimento registrado com sucesso!',
            dados: {
                id_movimento: result.id,
                id_caixa: caixaAberto.id
            }
        });

    } catch (error) {
        logger.error('Erro ao registrar movimento:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 5. LISTAR MOVIMENTOS
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
// 6. EDITAR MOVIMENTO
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

        const camposAtualizaveis = ['requisicao', 'usuario', 'valor', 'tipo_transacao', 
                                    'forma_pagamento', 'descricao_transacao', 'posto_coleta'];
        
        const updates = [];
        const params = [];

        camposAtualizaveis.forEach(campo => {
            if (value[campo] !== undefined) {
                updates.push(`${campo} = ?`);
                params.push(value[campo]);
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

        await registrarAuditoria(value.usuario || 'Sistema', 'EDICAO_MOVIMENTO', {
            id_movimento: id,
            motivo: value.motivo_edicao,
            campos_alterados: Object.keys(value)
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: 'Movimento atualizado com sucesso!'
        });

    } catch (error) {
        logger.error('Erro ao editar movimento:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 7. DELETAR MOVIMENTO
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

        await dbRun('DELETE FROM movimentos WHERE id = ?', [id]);

        await registrarAuditoria(usuario, 'EXCLUSAO_MOVIMENTO', {
            id_movimento: id,
            motivo: motivo,
            movimento_excluido: movimento
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: 'Movimento deletado com sucesso!'
        });

    } catch (error) {
        logger.error('Erro ao deletar movimento:', error);
        res.status(500).json({ erro: true, mensagem: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────
// 8. ✅ IMPORTAR EXCEL (CORRIGIDO)
// ───────────────────────────────────────────────────────────────────────

app.post('/api/importar', authMiddleware, uploadLimiter, upload.single('arquivo'), async (req, res) => {
    let importados = 0;
    let erros = [];

    try {
        // ✅ VERIFICAÇÃO 1: Arquivo enviado
        if (!req.file) {
            logger.error('Nenhum arquivo foi enviado na requisição');
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Nenhum arquivo foi enviado. Por favor, selecione um arquivo Excel (.xlsx ou .xls)' 
            });
        }

        logger.info(`Arquivo recebido: ${req.file.originalname} (${req.file.size} bytes)`);

        // ✅ VERIFICAÇÃO 2: Caixa aberto
        const caixaAberto = await dbGet(
            'SELECT id FROM caixa_controle WHERE status = "ABERTO" ORDER BY data_abertura DESC LIMIT 1'
        );

        if (!caixaAberto) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            logger.error('Tentativa de importação sem caixa aberto');
            return res.status(400).json({ 
                erro: true, 
                mensagem: 'Nenhum caixa aberto. Abra um caixa antes de importar dados.' 
            });
        }

        // ✅ VERIFICAÇÃO 3: Leitura do arquivo Excel
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

        // ── log de debug: headers reais do Excel ──
        if (dados.length > 0) {
            logger.info('Headers detectados: ' + JSON.stringify(Object.keys(dados[0])));
        }

        let duplicatas = 0;

        // ✅ VERIFICAÇÃO 4: Processar cada linha
        for (let i = 0; i < dados.length; i++) {
            const linha = dados[i];
            const numeroLinha = i + 2;

            try {
                // ─── MAPEAMENTO (headers reais confirmados nos logs) ───
                // Requisicao | DataCadastro | Usuario | DataTransacao |
                // Pagamento | TotalPedido | Descontos | TotalPago | Saldo |
                // Nome | Sobrenome | DescricaoTransacao | TipoMovimento |
                // CPF | Convenio | Departamento | PostoColeta | Setor | MessagenAdministrativa

                const requisicao  = String(linha['Requisicao']  || '').trim();
                const descricao   = String(linha['DescricaoTransacao'] || '').trim();
                const usuario     = String(linha['Usuario']     || 'Sistema').trim();
                const posto       = String(linha['PostoColeta'] || '').trim();
                const nomeCompleto = [linha['Nome'] || '', linha['Sobrenome'] || ''].join(' ').trim();

                // ── Valor: Pagamento primeiro, fallback TotalPago ──
                const valorRaw =
                    linha['Pagamento'] !== undefined && linha['Pagamento'] !== '' ? linha['Pagamento'] :
                    linha['TotalPago'] !== undefined && linha['TotalPago'] !== '' ? linha['TotalPago'] : 0;

                // ── Data: DataTransacao convertida, fallback DataCadastro ──
                const dataCadastro = converterData(linha['DataTransacao'] || linha['DataCadastro']);

                // ── Valor numérico ──
                let valor = parseFloat(String(valorRaw).replace(/[^\d.,-]/g, '').replace(',', '.'));

                // Valor 0 ou NaN → ignora
                if (isNaN(valor) || valor === 0) {
                    logger.warn(`Linha ${numeroLinha}: valor zerado/inválido "${valorRaw}" — ignorada`);
                    continue;
                }

                // ── ANTI-DUPLICATA: se Requisicao existe, verifica no banco ──
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

                // ── TIPO DE TRANSAÇÃO: sinal → TipoMovimento → descrição ──
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

                // ── FORMA DE PAGAMENTO ──
                const formaPagamento = detectarFormaPagamento(descricao);

                // ── DESCRIÇÃO FINAL (nome do cliente + descrição) ──
                let descricaoFinal = descricao;
                if (nomeCompleto && !descricao.toUpperCase().includes(nomeCompleto.toUpperCase())) {
                    descricaoFinal = nomeCompleto + (descricao ? ' - ' + descricao : '');
                }

                // ── INSERIR ──
                await dbRun(
                    `INSERT INTO movimentos 
                     (id_caixa, requisicao, data_cadastro, usuario, valor, tipo_transacao, forma_pagamento, descricao_transacao, posto_coleta) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        caixaAberto.id,
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
                logger.info(`Linha ${numeroLinha} importada: valor=${valor} tipo=${tipoTransacao} forma=${formaPagamento} data=${dataCadastro}`);

            } catch (erroLinha) {
                logger.error(`Erro na linha ${numeroLinha}:`, erroLinha);
                erros.push(`Linha ${numeroLinha}: ${erroLinha.message}`);
            }
        }

        // Limpar arquivo
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        // ✅ RESPOSTA FINAL
        await registrarAuditoria(req.body.usuario || 'Sistema', 'IMPORTACAO_EXCEL', {
            arquivo: req.file.originalname,
            importados: importados,
            erros: erros.length
        }, req.ip);

        res.json({
            sucesso: true,
            mensagem: `Importação concluída! ${importados} importado(s).${duplicatas > 0 ? ' ' + duplicatas + ' duplicata(s) ignorada(s).' : ''}`,
            dados: {
                importados: importados,
                duplicatas_ignoradas: duplicatas,
                erros: erros.length,
                detalhes_erros: erros.slice(0, 10)
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
// 8b. CLEANUP — remover duplicatas existentes no banco
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

        // Encontra IDs duplicados: agrupa por (id_caixa, requisicao, valor, data_cadastro, tipo_transacao)
        // e mantém apenas o menor ID de cada grupo (o primeiro inserido)
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

        // Remove uma por uma dentro de uma transação
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
// 9. BACKUP
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
// 10. RELATÓRIOS
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
// ✅ TRATAMENTO DE ERROS 404 E 500 (SEMPRE RETORNA JSON)
// ═══════════════════════════════════════════════════════════════════════

// 404 - Rota não encontrada
app.use((req, res) => {
    res.status(404).json({
        erro: true,
        mensagem: `Rota não encontrada: ${req.method} ${req.path}`,
        rotas_disponiveis: [
            'POST /api/caixa/abrir',
            'POST /api/caixa/fechar',
            'GET /api/caixa/status',
            'POST /api/movimento',
            'GET /api/movimentos',
            'PUT /api/movimento/:id',
            'DELETE /api/movimento/:id',
            'POST /api/importar',
            'POST /api/cleanup',
            'POST /api/backup',
            'GET /api/relatorio',
            'GET /api/relatorio/exportar',
            'GET /api/auditoria'
        ]
    });
});

// 500 - Erro interno do servidor
app.use((err, req, res, next) => {
    logger.error('Erro não tratado:', err);
    
    // Se for erro do Multer
    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            erro: true,
            mensagem: `Erro no upload: ${err.message}`,
            tipo: 'MULTER_ERROR',
            campo: err.field
        });
    }
    
    // Outros erros
    res.status(500).json({
        erro: true,
        mensagem: err.message || 'Erro interno do servidor',
        tipo: err.name || 'INTERNAL_ERROR',
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
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
║   🚀 SISTEMA DE CONTROLE DE CAIXA V5.4 - DATAS + CLEANUP            ║
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
║   ✅ CORREÇÕES V5.4:                                                 ║
║   • Datas DD/MM/YYYY convertidas corretamente                        ║
║   • Anti-duplicata na importação                                     ║
║   • POST /api/cleanup remove duplicatas existentes                   ║
║   • Migration: coluna detalhes na auditoria                          ║
║   • Saldo = Inicial + CRÉDITO - DÉBITO                               ║
║                                                                       ║
╚═══════════════════════════════════════════════════════════════════════╝
    `);
    
    logger.info('✅ Sistema V5.4 iniciado - Datas + Cleanup!');
});
