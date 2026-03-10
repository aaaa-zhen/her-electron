package com.example.pi.ui.chat.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.pi.ui.theme.Accent
import com.example.pi.ui.theme.AccentDim
import com.example.pi.ui.theme.TextPrimary

/**
 * 轻量级 Markdown 渲染组件。
 * 支持：**粗体**、*斜体*、`行内代码`、# 标题、- 列表、数字列表
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = TextPrimary,
    fontSize: Float = 15f,
    lineHeight: Float = 24f
) {
    val blocks = remember(text) { parseBlocks(text) }

    Column(modifier = modifier) {
        blocks.forEachIndexed { index, block ->
            when (block) {
                is Block.Heading -> {
                    if (index > 0) Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = parseInline(block.text),
                        fontSize = when (block.level) {
                            1 -> 19.sp
                            2 -> 16.sp
                            else -> 14.sp
                        },
                        fontWeight = FontWeight.Bold,
                        color = color,
                        lineHeight = lineHeight.sp
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                }

                is Block.ListItem -> {
                    Row(modifier = Modifier.padding(start = 4.dp)) {
                        Text(
                            text = block.bullet,
                            fontSize = fontSize.sp,
                            color = color.copy(alpha = 0.5f)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = parseInline(block.text),
                            fontSize = fontSize.sp,
                            lineHeight = lineHeight.sp,
                            color = color
                        )
                    }
                }

                is Block.Paragraph -> {
                    if (index > 0 && blocks[index - 1] is Block.Paragraph) {
                        Spacer(modifier = Modifier.height(8.dp))
                    }
                    Text(
                        text = parseInline(block.text),
                        fontSize = fontSize.sp,
                        lineHeight = lineHeight.sp,
                        color = color
                    )
                }

                is Block.CodeBlock -> {
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = block.code,
                        fontSize = 13.sp,
                        fontFamily = FontFamily.Monospace,
                        color = Accent,
                        lineHeight = 20.sp,
                        modifier = Modifier.padding(vertical = 4.dp)
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                }

                is Block.Empty -> {
                    Spacer(modifier = Modifier.height(4.dp))
                }
            }
        }
    }
}

private val ORDERED_LIST_CHECK = Regex("""^\d+[.)]\s.*""")
private val ORDERED_LIST_CAPTURE = Regex("""^(\d+[.)])\s(.*)""")

private sealed class Block {
    data class Heading(val level: Int, val text: String) : Block()
    data class ListItem(val bullet: String, val text: String) : Block()
    data class Paragraph(val text: String) : Block()
    data class CodeBlock(val code: String) : Block()
    data object Empty : Block()
}

private fun parseBlocks(text: String): List<Block> {
    val lines = text.lines()
    val blocks = mutableListOf<Block>()
    var i = 0

    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trim()

        when {
            // 代码块
            trimmed.startsWith("```") -> {
                val codeLines = mutableListOf<String>()
                i++
                while (i < lines.size && !lines[i].trim().startsWith("```")) {
                    codeLines.add(lines[i])
                    i++
                }
                blocks.add(Block.CodeBlock(codeLines.joinToString("\n")))
                i++ // skip closing ```
            }

            // 标题
            trimmed.startsWith("### ") -> {
                blocks.add(Block.Heading(3, trimmed.removePrefix("### ")))
                i++
            }
            trimmed.startsWith("## ") -> {
                blocks.add(Block.Heading(2, trimmed.removePrefix("## ")))
                i++
            }
            trimmed.startsWith("# ") -> {
                blocks.add(Block.Heading(1, trimmed.removePrefix("# ")))
                i++
            }

            // 无序列表
            trimmed.startsWith("- ") || trimmed.startsWith("* ") -> {
                blocks.add(Block.ListItem("•", trimmed.substring(2)))
                i++
            }

            // 有序列表
            trimmed.matches(ORDERED_LIST_CHECK) -> {
                val match = ORDERED_LIST_CAPTURE.find(trimmed)
                if (match != null) {
                    blocks.add(Block.ListItem(match.groupValues[1], match.groupValues[2]))
                }
                i++
            }

            // 空行
            trimmed.isEmpty() -> {
                if (blocks.lastOrNull() !is Block.Empty) {
                    blocks.add(Block.Empty)
                }
                i++
            }

            // 普通段落
            else -> {
                // 合并连续的非空行
                val paraLines = mutableListOf(trimmed)
                i++
                while (i < lines.size) {
                    val next = lines[i].trim()
                    if (next.isEmpty() || next.startsWith("#") || next.startsWith("- ") ||
                        next.startsWith("* ") || next.startsWith("```") ||
                        next.matches(ORDERED_LIST_CHECK)
                    ) break
                    paraLines.add(next)
                    i++
                }
                blocks.add(Block.Paragraph(paraLines.joinToString(" ")))
            }
        }
    }

    return blocks
}

/**
 * 解析行内 Markdown：**粗体**、*斜体*、`代码`
 */
private fun parseInline(text: String): AnnotatedString {
    return buildAnnotatedString {
        var i = 0
        while (i < text.length) {
            when {
                // **粗体**
                i + 1 < text.length && text[i] == '*' && text[i + 1] == '*' -> {
                    val end = text.indexOf("**", i + 2)
                    if (end > 0) {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
                            append(text.substring(i + 2, end))
                        }
                        i = end + 2
                    } else {
                        append(text[i])
                        i++
                    }
                }

                // *斜体*（单个 * 且不是 **）
                text[i] == '*' && (i + 1 >= text.length || text[i + 1] != '*') -> {
                    val end = text.indexOf('*', i + 1)
                    if (end > 0) {
                        withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
                            append(text.substring(i + 1, end))
                        }
                        i = end + 1
                    } else {
                        append(text[i])
                        i++
                    }
                }

                // `行内代码`
                text[i] == '`' -> {
                    val end = text.indexOf('`', i + 1)
                    if (end > 0) {
                        withStyle(SpanStyle(
                            fontFamily = FontFamily.Monospace,
                            color = Accent,
                            fontSize = 13.sp
                        )) {
                            append(text.substring(i + 1, end))
                        }
                        i = end + 1
                    } else {
                        append(text[i])
                        i++
                    }
                }

                else -> {
                    append(text[i])
                    i++
                }
            }
        }
    }
}
