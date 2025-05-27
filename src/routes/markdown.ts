import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { HtmlToNotionService } from '../services/htmlToNotionService';
import { createError } from '../middleware/errorHandler';

const router = Router();
const htmlToNotionService = new HtmlToNotionService();

// 配置multer用于文件上传
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/markdown' || file.originalname.endsWith('.md')) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  }
});

// API文档端点
router.get('/', (req: Request, res: Response) => {
  res.json({
    service: 'md-to-notion API',
    version: '1.0.0',
    endpoints: {
      'POST /sync': '将markdown转换并创建Notion子页面',
      'POST /upload': '上传markdown文件并创建Notion子页面'
    },
          usage: {
        sync: {
          method: 'POST',
          url: '/api/markdown/sync',
          body: {
            content: 'markdown内容字符串',
            notion_api_key: 'Notion API密钥',
            notion_page_id: '父页面ID',
            title: '文章标题（可选）'
          },
          description: '使用Showdown库转换markdown并创建Notion子页面，支持丰富格式'
        },
        upload: {
          method: 'POST',
          url: '/api/markdown/upload',
          body: 'multipart/form-data with file field + notion_api_key + notion_page_id',
          description: '上传.md文件并自动创建Notion子页面'
        }
      }
  });
});

// 创建markdown子页面
router.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content, title, notion_api_key, notion_page_id } = req.body;

    if (!content) {
      throw createError('缺少markdown内容', 400);
    }
    if (!notion_api_key) {
      throw createError('缺少notion_api_key参数', 400);
    }
    if (!notion_page_id) {
      throw createError('缺少notion_page_id参数', 400);
    }

    const result = await htmlToNotionService.markdownToNotion(content, notion_api_key, notion_page_id, title);
    
    res.json({
      success: true,
      message: 'notion 页面创建成功',
      data: result
    });
  } catch (error) {
    next(error);
  }
});

// 上传markdown文件并创建子页面
router.post('/upload', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      throw createError('未找到上传的文件', 400);
    }

    const { notion_api_key, notion_page_id } = req.body;
    
    if (!notion_api_key) {
      throw createError('缺少notion_api_key参数', 400);
    }
    if (!notion_page_id) {
      throw createError('缺少notion_page_id参数', 400);
    }

    const content = req.file.buffer.toString('utf-8');
    const title = req.body.title || req.file.originalname.replace('.md', '');

    const result = await htmlToNotionService.markdownToNotion(content, notion_api_key, notion_page_id, title);
    
    res.json({
      success: true,
      message: '文件上传并创建子页面成功',
      data: result
    });
  } catch (error) {
    next(error);
  }
});

export { router as markdownRouter }; 