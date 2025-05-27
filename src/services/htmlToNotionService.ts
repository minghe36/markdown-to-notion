import { Client } from '@notionhq/client';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as showdown from 'showdown';
import { createError } from '../middleware/errorHandler';

export interface HtmlToNotionResult {
  success: boolean;
  notionPageId?: string;
  title: string;
  timestamp: string;
  blocksCreated: number;
  imagesProcessed: number;
  batches?: number;
}

export class HtmlToNotionService {
  private converter: showdown.Converter;

  constructor() {
    // 配置showdown转换器
    this.converter = new showdown.Converter({
      tables: true,                    // 支持表格
      strikethrough: true,            // 支持删除线
      tasklists: true,                // 支持任务列表
      ghCodeBlocks: true,             // 支持GitHub风格代码块
      smoothLivePreview: true,        // 平滑预览
      simplifiedAutoLink: true,       // 简化自动链接
      excludeTrailingPunctuationFromURLs: true, // 排除URL末尾标点
      literalMidWordUnderscores: true, // 字面中间下划线
      simpleLineBreaks: true,         // 简单换行
      openLinksInNewWindow: false,    // 不在新窗口打开链接
      backslashEscapesHTMLTags: true, // 反斜杠转义HTML标签
      emoji: true,                    // 支持emoji
      underline: true,                // 支持下划线
      completeHTMLDocument: false,    // 不生成完整HTML文档
      metadata: false,                // 不解析元数据
      splitAdjacentBlockquotes: true  // 分割相邻引用块
    });
  }

  /**
   * 将markdown转换为HTML，然后创建子页面并存储内容
   */
  async markdownToNotion(
    content: string, 
    notionApiKey: string, 
    parentPageId: string, 
    title?: string
  ): Promise<HtmlToNotionResult> {
    const timestamp = new Date().toISOString();
    
    try {
      // 验证必需参数
      if (!notionApiKey) {
        throw createError('缺少notion_api_key参数', 400);
      }
      if (!parentPageId) {
        throw createError('缺少notion_page_id参数', 400);
      }

      // 创建Notion客户端
      const notion = new Client({
        auth: notionApiKey,
      });

      // 1. 将markdown转换为HTML
      const htmlContent = this.markdownToHtml(content);
      
      // 2. 解析HTML并转换为Notion blocks
      const blocks = await this.htmlToNotionBlocks(htmlContent);

      // 3. 提取或生成页面标题
      const pageTitle = title || this.extractTitleFromContent(content);

      // 4. 创建新的子页面
      const newPage = await notion.pages.create({
        parent: {
          type: 'page_id',
          page_id: parentPageId
        },
        properties: {
          title: {
            title: [
              {
                type: 'text',
                text: {
                  content: pageTitle
                }
              }
            ]
          }
        }
      });

      console.log(`✅ 成功创建子页面: ${pageTitle} (ID: ${newPage.id})`);

      // 5. 添加时间戳和分隔线到内容开头
      const timestampBlock = {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: `创建时间: ${new Date().toLocaleString()}`
              },
              annotations: {
                italic: true,
                color: 'gray'
              }
            }
          ]
        }
      };

      const dividerBlock = {
        object: 'block',
        type: 'divider',
        divider: {}
      };

      // 6. 将内容分批添加到新创建的子页面
      const allBlocks = [timestampBlock, dividerBlock, ...blocks];
      
      // Notion API限制：单次最多添加100个blocks
      const BATCH_SIZE = 100;
      let totalBlocksCreated = 0;
      
      for (let i = 0; i < allBlocks.length; i += BATCH_SIZE) {
        const batch = allBlocks.slice(i, i + BATCH_SIZE);
        
        console.log(`📦 正在添加第 ${Math.floor(i / BATCH_SIZE) + 1} 批blocks (${batch.length} 个)...`);
        
        await notion.blocks.children.append({
          block_id: newPage.id,
          children: batch
        });
        
        totalBlocksCreated += batch.length;
        
        // 添加短暂延迟以避免API限制
        if (i + BATCH_SIZE < allBlocks.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      // 7. 统计结果
      const imagesProcessed = blocks.filter((block: any) => block.type === 'image').length;

      console.log(`✅ 成功分 ${Math.ceil(allBlocks.length / BATCH_SIZE)} 批添加了 ${totalBlocksCreated} 个blocks到子页面，处理了 ${imagesProcessed} 个图片`);

      return {
        success: true,
        notionPageId: newPage.id,
        title: pageTitle,
        timestamp,
        blocksCreated: totalBlocksCreated,
        imagesProcessed,
        batches: Math.ceil(allBlocks.length / BATCH_SIZE)
      };

    } catch (error) {
      if (error instanceof Error) {
        throw createError(`创建子页面失败: ${error.message}`, 500);
      }
      throw createError('创建子页面过程中发生未知错误', 500);
    }
  }

  /**
   * 使用showdown库将markdown转换为HTML
   */
  private markdownToHtml(markdown: string): string {
    try {
      // 使用showdown转换器
      let html = this.converter.makeHtml(markdown);
      
      // 清理和优化HTML
      html = this.cleanupHtml(html);
      
      console.log('Markdown转HTML完成，长度:', html.length);
      return html;
    } catch (error) {
      console.error('Markdown转HTML失败:', error);
      // 如果showdown失败，回退到简单转换
      return this.fallbackMarkdownToHtml(markdown);
    }
  }

  /**
   * 清理和优化HTML
   */
  private cleanupHtml(html: string): string {
    // 移除不必要的空白
    html = html.replace(/\n\s*\n/g, '\n');
    
    // 清理空段落
    html = html.replace(/<p>\s*<\/p>/g, '');
    
    // 确保图片标签格式正确
    html = html.replace(/<img([^>]*?)>/g, '<img$1 />');
    
    // 清理多余的换行
    html = html.trim();
    
    return html;
  }

  /**
   * 回退的简单markdown转换（如果showdown失败）
   */
  private fallbackMarkdownToHtml(markdown: string): string {
    let html = markdown;

    // 标题转换
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // 粗体和斜体
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // 代码块
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    html = html.replace(/`(.*?)`/g, '<code>$1</code>');

    // 图片和链接
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // 段落处理
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br />');
    html = '<p>' + html + '</p>';

    // 清理
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p><br \/><\/p>/g, '');

    return html;
  }

  /**
   * 将HTML转换为Notion blocks
   */
  private async htmlToNotionBlocks(html: string): Promise<any[]> {
    const blocks: any[] = [];
    
    // 简单的HTML解析 - 按标签分割内容
    const elements = this.parseHtmlElements(html);
    
    for (const element of elements) {
      const block = await this.elementToNotionBlock(element);
      if (block) {
        blocks.push(block);
      }
    }

    return blocks;
  }

  /**
   * 解析HTML元素（改进版，更好地处理showdown生成的HTML）
   */
  private parseHtmlElements(html: string): Array<{tag: string, content: string, attributes?: any}> {
    const elements: Array<{tag: string, content: string, attributes?: any}> = [];
    
    // 先处理多行代码块
    html = this.preprocessCodeBlocks(html);
    
    // 按行分割HTML，逐行处理
    const lines = html.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // 处理图片
      const imgMatch = trimmedLine.match(/<img\s+([^>]*)\s*\/?>/);
      if (imgMatch) {
        const attrs = this.parseAttributes(imgMatch[1]);
        elements.push({
          tag: 'img',
          content: '',
          attributes: attrs
        });
        continue;
      }

      // 处理标题
      const headingMatch = trimmedLine.match(/<h([1-6])>(.*?)<\/h[1-6]>/);
      if (headingMatch) {
        elements.push({
          tag: `h${headingMatch[1]}`,
          content: headingMatch[2] // 保留HTML格式
        });
        continue;
      }

      // 处理代码块（现在应该是单行的）
      const codeBlockMatch = trimmedLine.match(/<pre><code(?:\s+class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/);
      if (codeBlockMatch) {
        let language = codeBlockMatch[1] || 'plain text';
        // 清理语言名称
        if (language.includes('language-')) {
          language = language.replace(/.*language-([^\s]+).*/, '$1');
        }
        // 确保语言名称是Notion支持的
        language = this.normalizeLanguage(language);
        elements.push({
          tag: 'pre',
          content: codeBlockMatch[2],
          attributes: { language }
        });
        continue;
      }

      // 处理引用块
      const blockquoteMatch = trimmedLine.match(/<blockquote>(.*?)<\/blockquote>/);
      if (blockquoteMatch) {
        elements.push({
          tag: 'blockquote',
          content: blockquoteMatch[1] // 保留HTML格式
        });
        continue;
      }

      // 处理列表项
      const listItemMatch = trimmedLine.match(/<li>(.*?)<\/li>/);
      if (listItemMatch) {
        elements.push({
          tag: 'li',
          content: listItemMatch[1] // 保留HTML格式
        });
        continue;
      }

      // 处理表格行
      const tableRowMatch = trimmedLine.match(/<tr>(.*?)<\/tr>/);
      if (tableRowMatch) {
        // 提取表格单元格
        const cells = [];
        const cellRegex = /<t[hd]>(.*?)<\/t[hd]>/g;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(tableRowMatch[1])) !== null) {
          cells.push(this.stripHtmlTags(cellMatch[1]));
        }
        if (cells.length > 0) {
          elements.push({
            tag: 'table-row',
            content: '',
            attributes: { cells }
          });
        }
        continue;
      }

      // 跳过表格结构标签
      if (trimmedLine.match(/<\/?table>|<\/?thead>|<\/?tbody>/)) {
        continue;
      }

      // 处理段落
      const paragraphMatch = trimmedLine.match(/<p>(.*?)<\/p>/);
      if (paragraphMatch) {
        const content = paragraphMatch[1]; // 保留HTML格式
        if (content.trim()) {
          elements.push({
            tag: 'p',
            content: content
          });
        }
        continue;
      }

      // 处理其他文本内容
      if (trimmedLine && !trimmedLine.startsWith('<') && !trimmedLine.endsWith('>')) {
        elements.push({
          tag: 'p',
          content: trimmedLine // 保留原始内容
        });
      }
    }

    return elements;
  }

  /**
   * 预处理代码块，将多行代码块合并为单行
   */
  private preprocessCodeBlocks(html: string): string {
    return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g, (match, attrs, content) => {
      // 将多行内容合并为单行，保留换行符
      const processedContent = content.replace(/\n/g, '\\n');
      return `<pre><code${attrs}>${processedContent}</code></pre>`;
    });
  }

  /**
   * 标准化语言名称，确保Notion支持
   */
  private normalizeLanguage(language: string): string {
    if (!language || language === 'plain text') {
      return 'plain text';
    }

    // 转换为小写并清理
    language = language.toLowerCase().trim();

    // Notion支持的语言映射
    const languageMap: { [key: string]: string } = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'rb': 'ruby',
      'sh': 'shell',
      'bash': 'shell',
      'zsh': 'shell',
      'yml': 'yaml',
      'md': 'markdown',
      'jsx': 'javascript',
      'tsx': 'typescript'
    };

    // 检查映射
    if (languageMap[language]) {
      return languageMap[language];
    }

    // Notion支持的语言列表（部分）
    const supportedLanguages = [
      'javascript', 'typescript', 'python', 'java', 'c', 'c++', 'c#',
      'ruby', 'go', 'rust', 'php', 'swift', 'kotlin', 'scala',
      'html', 'css', 'scss', 'sass', 'less', 'json', 'xml', 'yaml',
      'markdown', 'sql', 'shell', 'bash', 'powershell',
      'dockerfile', 'docker', 'makefile', 'plain text'
    ];

    // 检查是否支持
    if (supportedLanguages.includes(language)) {
      return language;
    }

    // 默认返回plain text
    return 'plain text';
  }

  /**
   * 将HTML转换为Notion rich_text格式
   */
  private htmlToRichText(html: string): any[] {
    const richText: any[] = [];
    
    // 简单的HTML解析，处理格式化标签
    let currentText = '';
    let i = 0;
    
    while (i < html.length) {
      if (html[i] === '<') {
        // 如果有累积的文本，先添加
        if (currentText) {
          richText.push({
            type: 'text',
            text: { content: currentText }
          });
          currentText = '';
        }
        
        // 查找标签结束
        const tagEnd = html.indexOf('>', i);
        if (tagEnd === -1) break;
        
        const tag = html.substring(i, tagEnd + 1);
        i = tagEnd + 1;
        
        // 处理不同的标签
        if (tag.startsWith('<strong>')) {
          const closeTag = html.indexOf('</strong>', i);
          if (closeTag !== -1) {
            const content = html.substring(i, closeTag);
            richText.push({
              type: 'text',
              text: { content: this.stripHtmlTags(content) },
              annotations: { bold: true }
            });
            i = closeTag + 9; // 跳过 </strong>
          }
        } else if (tag.startsWith('<em>')) {
          const closeTag = html.indexOf('</em>', i);
          if (closeTag !== -1) {
            const content = html.substring(i, closeTag);
            richText.push({
              type: 'text',
              text: { content: this.stripHtmlTags(content) },
              annotations: { italic: true }
            });
            i = closeTag + 5; // 跳过 </em>
          }
        } else if (tag.startsWith('<code>')) {
          const closeTag = html.indexOf('</code>', i);
          if (closeTag !== -1) {
            const content = html.substring(i, closeTag);
            richText.push({
              type: 'text',
              text: { content: this.stripHtmlTags(content) },
              annotations: { code: true }
            });
            i = closeTag + 7; // 跳过 </code>
          }
        } else if (tag.startsWith('<del>') || tag.startsWith('<s>')) {
          const closeTag = html.indexOf('</del>', i) !== -1 ? html.indexOf('</del>', i) : html.indexOf('</s>', i);
          if (closeTag !== -1) {
            const content = html.substring(i, closeTag);
            richText.push({
              type: 'text',
              text: { content: this.stripHtmlTags(content) },
              annotations: { strikethrough: true }
            });
            i = closeTag + (html.indexOf('</del>', i) !== -1 ? 6 : 4);
          }
        }
      } else {
        currentText += html[i];
        i++;
      }
    }
    
    // 添加剩余的文本
    if (currentText) {
      richText.push({
        type: 'text',
        text: { content: currentText }
      });
    }
    
    return richText.length > 0 ? richText : [{ type: 'text', text: { content: html } }];
  }

  /**
   * 移除HTML标签，只保留纯文本
   */
  private stripHtmlTags(html: string): string {
    let text = html;
    
    // 移除所有HTML标签
    text = text.replace(/<[^>]*>/g, '');
    
    // 解码HTML实体
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    
    return text.trim();
  }

  /**
   * 解析HTML属性
   */
  private parseAttributes(attrString: string): any {
    const attrs: any = {};
    const attrRegex = /(\w+)=["']([^"']*)["']/g;
    let match;
    
    while ((match = attrRegex.exec(attrString)) !== null) {
      attrs[match[1]] = match[2];
    }
    
    return attrs;
  }

  /**
   * 将HTML元素转换为Notion block
   */
  private async elementToNotionBlock(element: {tag: string, content: string, attributes?: any}): Promise<any> {
    switch (element.tag) {
      case 'h1':
        return {
          object: 'block',
          type: 'heading_1',
          heading_1: {
            rich_text: this.htmlToRichText(element.content)
          }
        };

      case 'h2':
        return {
          object: 'block',
          type: 'heading_2',
          heading_2: {
            rich_text: this.htmlToRichText(element.content)
          }
        };

      case 'h3':
        return {
          object: 'block',
          type: 'heading_3',
          heading_3: {
            rich_text: this.htmlToRichText(element.content)
          }
        };

      case 'p':
        if (!element.content.trim()) return null;
        return {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: this.htmlToRichText(element.content)
          }
        };

      case 'pre':
        // 恢复换行符
        const codeContent = element.content.replace(/\\n/g, '\n');
        return {
          object: 'block',
          type: 'code',
          code: {
            rich_text: [
              {
                type: 'text',
                text: {
                  content: codeContent
                }
              }
            ],
            language: element.attributes?.language || 'plain text'
          }
        };

      case 'blockquote':
        return {
          object: 'block',
          type: 'quote',
          quote: {
            rich_text: this.htmlToRichText(element.content)
          }
        };

      case 'li':
        return {
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: this.htmlToRichText(element.content)
          }
        };

      case 'table-row':
        // Notion不直接支持表格，转换为段落显示
        if (element.attributes && element.attributes.cells) {
          const cellsText = element.attributes.cells.join(' | ');
          return {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: {
                    content: `| ${cellsText} |`
                  },
                  annotations: {
                    code: true
                  }
                }
              ]
            }
          };
        }
        return null;

      case 'img':
        if (element.attributes && element.attributes.src) {
          // 验证图片URL是否可访问
          const isAccessible = await this.verifyImageUrl(element.attributes.src);
          if (isAccessible) {
            return {
              object: 'block',
              type: 'image',
              image: {
                type: 'external',
                external: {
                  url: element.attributes.src
                },
                caption: element.attributes.alt ? [
                  {
                    type: 'text',
                    text: {
                      content: element.attributes.alt
                    }
                  }
                ] : []
              }
            };
          } else {
            // 如果图片不可访问，创建一个说明段落
            return {
              object: 'block',
              type: 'callout',
              callout: {
                rich_text: [
                  {
                    type: 'text',
                    text: {
                      content: `图片无法显示: ${element.attributes.alt || '图片'}\n链接: ${element.attributes.src}\n原因: 图片链接无法访问或有访问限制`
                    }
                  }
                ],
                icon: {
                  emoji: "📷"
                },
                color: "yellow_background"
              }
            };
          }
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * 验证图片URL是否可访问
   */
  private async verifyImageUrl(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, { 
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Referer': new URL(url).origin
        }
      });
      return response.ok;
    } catch (error) {
      console.warn(`图片URL验证失败: ${url}`, error);
      return false;
    }
  }

  /**
   * 从内容中提取标题
   */
  private extractTitleFromContent(content: string): string {
    // 查找第一个H1标题
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      return h1Match[1].trim();
    }

    // 查找第一个H2标题
    const h2Match = content.match(/^##\s+(.+)$/m);
    if (h2Match) {
      return h2Match[1].trim();
    }

    // 使用第一行作为标题
    const firstLine = content.split('\n')[0];
    if (firstLine) {
      return firstLine.replace(/^#+\s*/, '').trim();
    }

    return '未命名文档';
  }
} 