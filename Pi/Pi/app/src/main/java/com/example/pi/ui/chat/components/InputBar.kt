package com.example.pi.ui.chat.components

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import coil.compose.AsyncImage
import com.example.pi.R
import com.example.pi.ui.theme.Accent
import com.example.pi.ui.theme.Background
import com.example.pi.ui.theme.CardBg
import com.example.pi.ui.theme.TextPrimary
import com.example.pi.ui.theme.TextTertiary
import java.io.File

@Composable
fun InputBar(
    onSend: (String, List<Uri>?) -> Unit,
    enabled: Boolean,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var text by rememberSaveable { mutableStateOf("") }
    var selectedImages by remember { mutableStateOf<List<Uri>>(emptyList()) }
    var showImageMenu by remember { mutableStateOf(false) }

    val imagePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickMultipleVisualMedia(maxItems = 4)
    ) { uris ->
        if (uris.isNotEmpty()) {
            selectedImages = selectedImages + uris
        }
    }

    var cameraUri by remember { mutableStateOf<Uri?>(null) }
    val cameraLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.TakePicture()
    ) { success ->
        if (success) {
            cameraUri?.let { uri ->
                selectedImages = selectedImages + uri
            }
        }
    }

    val canSend = enabled && (text.isNotBlank() || selectedImages.isNotEmpty())

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Background)
            .padding(horizontal = 12.dp)
            .padding(bottom = 8.dp, top = 6.dp)
    ) {
        // Main input card
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(24.dp))
                .background(CardBg)
        ) {
            // Image previews
            if (selectedImages.isNotEmpty()) {
                LazyRow(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, end = 16.dp, top = 14.dp)
                ) {
                    items(selectedImages) { uri ->
                        Box(modifier = Modifier.padding(end = 8.dp)) {
                            AsyncImage(
                                model = uri,
                                contentDescription = "Selected image",
                                modifier = Modifier
                                    .size(72.dp)
                                    .clip(RoundedCornerShape(12.dp)),
                                contentScale = ContentScale.Crop
                            )
                            Box(
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .size(20.dp)
                                    .clip(CircleShape)
                                    .background(Color.Black.copy(alpha = 0.6f))
                                    .clickable {
                                        selectedImages = selectedImages.filter { it != uri }
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    painter = painterResource(R.drawable.x),
                                    contentDescription = "Remove",
                                    modifier = Modifier.size(10.dp),
                                    tint = Color.White
                                )
                            }
                        }
                    }
                }
            }

            // Text input area — taller, more breathing room
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp)
                    .padding(top = 14.dp, bottom = 6.dp),
                textStyle = TextStyle(
                    fontSize = 16.sp,
                    color = TextPrimary,
                    lineHeight = 24.sp,
                    platformStyle = PlatformTextStyle(includeFontPadding = false)
                ),
                cursorBrush = SolidColor(Accent),
                maxLines = 5,
                enabled = enabled,
                decorationBox = { innerTextField ->
                    Box(modifier = Modifier.defaultMinSize(minHeight = 28.dp)) {
                        if (text.isEmpty()) {
                            Text(
                                text = "说点什么...",
                                fontSize = 16.sp,
                                lineHeight = 24.sp,
                                color = TextTertiary,
                                style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
                            )
                        }
                        innerTextField()
                    }
                }
            )

            // Bottom actions row
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 8.dp, end = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Camera / image picker
                Box {
                    IconButton(
                        onClick = { showImageMenu = true },
                        enabled = enabled,
                        modifier = Modifier.size(40.dp)
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.camera),
                            contentDescription = "Attach image",
                            modifier = Modifier.size(22.dp),
                            tint = if (enabled) TextTertiary else TextTertiary.copy(alpha = 0.38f)
                        )
                    }

                    DropdownMenu(
                        expanded = showImageMenu,
                        onDismissRequest = { showImageMenu = false },
                        shape = RoundedCornerShape(14.dp),
                        containerColor = CardBg,
                        shadowElevation = 8.dp
                    ) {
                        DropdownMenuItem(
                            text = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        imageVector = Icons.Outlined.CameraAlt,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp),
                                        tint = Accent
                                    )
                                    Spacer(modifier = Modifier.width(10.dp))
                                    Text(
                                        "拍照",
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = TextPrimary
                                    )
                                }
                            },
                            onClick = {
                                showImageMenu = false
                                val cacheDir = File(context.cacheDir, "camera").apply { mkdirs() }
                                val file = File(cacheDir, "photo_${System.currentTimeMillis()}.jpg")
                                val uri = FileProvider.getUriForFile(
                                    context,
                                    "${context.packageName}.fileprovider",
                                    file
                                )
                                cameraUri = uri
                                cameraLauncher.launch(uri)
                            }
                        )
                        DropdownMenuItem(
                            text = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        imageVector = Icons.Outlined.Image,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp),
                                        tint = Accent
                                    )
                                    Spacer(modifier = Modifier.width(10.dp))
                                    Text(
                                        "从相册选择",
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = TextPrimary
                                    )
                                }
                            },
                            onClick = {
                                showImageMenu = false
                                imagePickerLauncher.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                                )
                            }
                        )
                    }
                }

                Spacer(modifier = Modifier.weight(1f))

                // Send button — larger, more prominent
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(
                            if (canSend) Accent else TextTertiary.copy(alpha = 0.4f)
                        )
                        .clickable(enabled = canSend) {
                            onSend(text.trim(), selectedImages.ifEmpty { null })
                            text = ""
                            selectedImages = emptyList()
                        },
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        painter = painterResource(R.drawable.arrow_up),
                        contentDescription = "Send",
                        modifier = Modifier.size(18.dp),
                        tint = if (canSend) Color(0xFF0C0C0C) else Color(0xFF0C0C0C).copy(alpha = 0.5f)
                    )
                }
            }
        }
    }
}
