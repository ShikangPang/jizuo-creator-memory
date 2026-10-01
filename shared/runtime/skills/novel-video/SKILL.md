---
name: novel-video
description: 将即作小说改编为动态漫或剧情短视频，提取人物与场景生成提示词，维护制作稿和分镜提示词，生成镜头素材，剪辑、配音和导出，检查或恢复自动制作任务
scope: builtin
---

# 小说视频制作

小说和视频是独立项目，各有自己的目录。视频以 sourceWorkId 引用小说章节；目标 workId 始终是视频项目 ID。仅旧混合作品允许省略 sourceWorkId，省略时沿用目标 workId。使用即作原生视频工具读取和修改已保存的视频项目，不修改原著正文，不直接写项目 JSON，不模拟生成结果。原著章节写作遵循 novel-workflow 的直接创作与按需完整生产路由。

用户已给出 workId 和 episodeId 时直接读取该作品的视频项目，不重复创建作品、不按标题重新匹配。目标 ID 缺失时才使用只读作品工具解析真实 ID，再调用 jizuo_read_video_project。所有修改的 expectedRevision 来自最新读取结果，冲突后重新读取并保留作者的新修改。所选界面本身不能替代明确的作品归属。

人物、场景和镜头提示词的创作、讨论、优化及保存，或引用剪辑片段进行调整时，先加载 `creative-prompt` Skill。该 Skill 维护提示词质量、引用对象和写入规则；本 Skill 负责制作与生成流程。

- 新视频集：使用 jizuo_create_video_episode 关联原著章节。先确认人物与场景生成提示词，再整理剧本、分镜画面、对白、时长和提示词，随后生成图片和视频。仅要求修改设定或制作稿时不启动媒体生成。
- 人物与场景：jizuo_extract_video_designs 从本集原著和剧本提取新的设定，只追加并保留已有设定，不为统一提示词而改写已有版本。只有用户明确要求修改已有设定时，才调用 jizuo_save_video_design 更新对应 id；作者要求手动新建时不传 id，保存、锁定或复制具体版本均遵循作者意图。jizuo_tag_video_asset 用于归入已有图片。生成设定图传 designId 与 view，不传 shotId。
- 人物设定图：按 character-prompts skill，未指定布局时推荐 kind=image、view=character-sheet、aspectRatio=16:9，一次生成一张两行三列的六宫格，上排全身正面、侧面、背面，下排三张面部或辨识特征特写。明确选择三视图时使用 view=turnaround，正面、侧面、背面依次横排；同一角色保持身份、服装、体型比例和画风一致。三视图是一次请求、一个图片素材，不拆成三个请求，也不先生成三张再拼接。有已确认参考图时沿用 referenceAssetIds，没有时直接根据设定生成；不要求先付费生成单独正面。作者明确要求单视图补图时才使用 front/side/back/expression/outfit。三视图可作为角色外观参考；制作视频镜头时先生成对应单镜头画面，避免直接把设定图排版带入视频。
- 360° 场景：view=panorama 请求完整 2:1 等距柱状投影空场景。生成成功不等于接缝和空间正确，提示作者打开环景查看并取景；镜头只引用取景后的普通图片，不能直接引用 panorama 原图。锁定设定需复制新版本后调整，不替换已选镜头素材。
- 作者调整：jizuo_update_video_episode 保存内容，保留其余镜头与锁定字段。不能为方便生成自行解锁；更新提示词后旧素材保留为候选，重新生成使用最新已保存内容。
- 整集自动制作：用户有明确生成意图且给出请求次数上限后，使用 jizuo_start_video_production。默认 pauseAfterStoryboard=true，制作稿完成后由作者调整并继续。已有制作稿、选定素材及人工剪辑会被复用。requestId 使用 UUID，同一次请求超时重试必须沿用原 ID。
- 查询与继续：先读现有项目和任务，再用 jizuo_control_video_production 的 pause/resume/cancel。只有用户明确追加次数时才传 additionalRequests，并为该次追加保留稳定 requestId。请求次数不是金额，不能承诺实际费用。
- 单镜头与批量：使用 jizuo_generate_video_media 或 jizuo_submit_video_batch，生成前检查是否已有运行或结果未确认的任务。批量重试保留 batchId。未知提交结果先核对；禁止改 ID、重复启动或自动重交绕过次数上限。
- 素材与剪辑：使用 jizuo_select_video_asset / jizuo_rename_video_asset；使用 jizuo_edit_video_timeline 修改顺序、裁剪、拆分、音量、字幕、转场和配音位置。jizuo_rough_cut_video 会重建时间线，仅在用户要求时使用。历史可通过 jizuo_read_video_timeline_history 查看，明确目标版本后使用 jizuo_restore_video_timeline，仅恢复时间线。
- 配音与导出：jizuo_generate_video_speech 生成语音素材后，使用剪辑工具插入音轨；jizuo_export_video 根据保存的时间线导出 MP4。配音生成与自动制作当前是独立入口。导出任务成功才表示成片已生成；不声称用户已将文件保存到外部目录。

在设置的统一模型页面中，图片、视频分类各自选择默认模型；文本改编使用当前默认文字模型；语音模型另行配置。需要配置时提示用户打开设置，不索取或展示密钥。只报告公开状态、失败原因和可执行的下一步，不展示内部凭据引用、快照或本地私有路径。

## 在当前对话生成制作稿

作品和视频集 ID 从本条消息的视频集引用 target 读取，局部镜头范围从引用 task.shotIds 读取，改编要求从 task.instructions 或用户正文读取；引用是定位快照，保存前仍读取最新项目。

用户要求生成制作稿、重新整理制作稿或 AI 调整镜头时，直接在当前对话创作，保存到目标 workId、episodeId，不新建作品或视频集，不调用 jizuo_adapt_video_episode，不启动小说写作工作流。

1. **读取来源**：调用 jizuo_read_video_project，参数仅为 {"input":{"workId":"目标workId"}}。按 episodeId 定位视频集，记录项目 revision、sourceChapters、script、shots、designs 和 visualStyle。读取原著正文时调用 jizuo_read_video_episode_sources，参数为 {"input":{"workId":"目标workId","episodeId":"目标episodeId","includeContent":true}}。沿最新 sourceChapters 逐章使用返回的 content、sourceWorkId 和 currentRevisionToken，按关联顺序核对来源；不依赖写作插件的章节工具。revisionToken 是已保存的历史来源版本，currentRevisionToken 是本次读取版本，两者不可混淆。只检查关联信息时可省略 includeContent。请求中的章节快照只供定位，不凭标题猜章节。来源缺失、正文读取失败或超过工具读取上限时停止并说明具体原因，必要时请用户缩小关联章节范围；不编造或静默截断原文。
2. **补齐设定**：整集改编先检查未删除的 designs，再调用 jizuo_extract_video_designs，input 为 workId、episodeId、最新 expectedRevision。仅补充原著及本集剧本涉及的缺失人物、场景；明确别名、称谓、同一地点不同叫法复用已有设定，换装或昼夜变化不新建设定。保留已有 id、描述、版本、锁定状态和素材。提取成功后沿用返回的最新 revision 和 designs，无新增也继续。指定 shotIds 时只调整目标镜头，不执行整集提取。提取失败如实报告，不绕过去重工具盲目创建。
3. **编写制作稿**：先简要报告已读取的章节和准备改编的情节。结合完整原文、已保存 script、designs、visualStyle 和用户 instructions 编写剧本及分镜；instructions 为空时无需另行确认。每个镜头包含标题、画面描述、对白、时长、静态图片提示词和描述动作、运镜、声音的视频提示词。已有镜头使用原 ID，保留锁定镜头、锁定提示词、素材关联、归档镜头及非目标字段。新镜头按工具 schema 填全必需字段，使用唯一 ID，revision 为 0，锁定值为 false，无参考素材时 referenceAssetIds 为 []，imageAssetId、videoAssetId 直接省略（不能传 null 或空字符串），对白可为空。designs[].id 只标识设定，不是 assets[].id；提取设定只生成文字，不生成素材，不能把设定 ID、人物名、场景名或占位符填入素材字段。仅引用当前 assets 中已存在且类型匹配的素材。
4. **保存并核对**：调用 jizuo_update_video_episode，参数为 {"input":{"workId":"目标workId","episodeId":"目标episodeId","expectedRevision":最新项目版本,"patch":本次改动}}。提交 shots 数组时包含所有应保留的镜头。版本冲突后重新读取并合并，不能只换 expectedRevision 重交旧稿。核对成功返回的目标视频集，报告原著章节、镜头数量、总时长、复用及新增设定和保存结果；工具未确认成功不能声称已保存。

视频工具业务参数放在 input 对象内，jizuo_read_chapter 参数在顶层，不传 JSON 字符串。参数错误依工具 schema 和具体报错修正一次，仍失败则报告并停止。技能或工具不可用时说明缺失，不安装插件、不搜索或修改 Harness 源码、不执行 shell 猜参数。限流或服务错误如实报告进度，不视为作品不存在。本流程不生成或购买图片、视频素材。

## 界面生成制作稿指令模板

```prompt:storyboard-chat-task
使用 novel-video 技能的“在当前对话生成制作稿”流程，为已有视频集{{action}}，保存到同一视频集并简要报告进度。
{{#instructions}}改编要求：{{instructions}}{{/instructions}}
```


## 视频工具参数说明

```prompt:media-tool-1
{{v0}} input 格式：{{v1}}
```

```prompt:media-tool-2
传入完整参数对象，ID 和 expectedRevision 必须来自最新视频项目
```

```prompt:media-tool-3
读取独立视频项目的视频集、制作稿、素材、剪辑和任务。只传 {"input":{"workId":"实际作品ID"}}，不传 episodeId。返回项目顶层 revision 用于后续修改；在 episodes 中按 id 定位视频集，其 sourceChapters 提供原著 sourceWorkId、volumeId 和 chapterId，调用 jizuo_read_video_episode_sources 并传 includeContent:true 即可读取已关联小说正文，不依赖写作插件。
```

```prompt:media-tool-4
为已引用或明确指定的人物、场景直接保存新创作或优化后的完整基础提示词。用户要求生成、创作、优化、修改或替换该对象的提示词时调用，无需再让用户复制确认；仅讨论、比较或要求先看不保存时不调用。先读取最新项目，传 workId、designId、expectedRevision 和 prompt 即可。只替换 description，保留名称、版本、锁定状态、参考图和全部已有素材，不自动生成图片。锁定对象不能自行解锁，版本冲突后重新读取。{{>design-description}}
```

```prompt:media-tool-5
按作品画风保存明确范围内的优化提示词。只改提示词文字，保留人物事实、当前素材选用和剪辑；锁定对象自动跳过，stylePromptHistory 返回变更及跳过记录。读取最新作品及 styleRevision 后调用；不生成媒体。
```

```prompt:media-tool-6
撤销一次画风提示词整理，后续已修改或锁定的提示词不会被覆盖。读取最新 revision 和 historyId 后调用。
```

```prompt:media-tool-7
保存当前作品统一画风。仅在用户明确要求修改作品画风时调用；人物、场景和全部图片视频继承，不支持局部覆盖。style:null 清除画风；不会生成素材。
```

```prompt:media-tool-8
在视频项目内创建视频集，可关联其他小说项目章节。跨项目来源必须携带 sourceWorkId，不修改小说或把小说目录转换为视频目录。
```

```prompt:media-tool-9
保存剧本和分镜制作稿。参数必须是 {"input":{"workId":"实际作品ID","episodeId":"实际视频集ID","expectedRevision":最新项目revision,"patch":{"script":"剧本正文","shots":[完整镜头对象]}}}。patch 仅提交实际修改的字段；shots 是完整保留列表而非增量。镜头必需字段为 id、title、description、dialogue、prompt、durationSec、referenceAssetIds、locked、promptLocked、revision，制作稿还应填写 videoPrompt。新镜头 revision=0，locked=false，promptLocked=false，无素材则 referenceAssetIds=[] 并省略 imageAssetId/videoAssetId，不能传 null、空字符串、名称或占位符。designs[].id 是文字设定 ID，不是 assets[].id；提取设定不会生成图片或视频。图片字段只能用当前 assets 中 kind=image 的 ID，视频字段只能用 kind=video 的 ID。先读项目，保留原镜头 ID、锁定字段、素材关联及非目标镜头；不能自行解锁。
```

```prompt:media-tool-10
用户要求优化、调整、改写、采用、保存或替换所引用镜头的提示词时，用完整优化结果直接替换对应的一项提示词，无需用户再复制。仅讨论、提问、比较方案或明确要求先不保存时不调用；多个引用仅处理用户指定目标。kind=image 保存静态画面 prompt，kind=video 保存动态视频 videoPrompt，不擅自同时修改两项。先读取最新项目获取作品、视频集、镜头 ID 和 expectedRevision，保留用户最新修改；不通过整集 shots 数组替换单条提示词。镜头或提示词锁定时不可自行解锁。版本冲突后重新核对，不直接重试覆盖；仅在工具成功返回后说明已保存。仅保存文本，不生成媒体、不修改已有任务快照；已有素材保留在素材库。图片提示词变化会清除旧镜头素材的选用，视频提示词变化保留当前视频供对比。
```

```prompt:media-tool-11
依据所选原著生成或局部修改剧本和分镜提示词。此操作不生成图片或视频。
```

```prompt:media-tool-12
按作者要求保存作品人物或场景设定、锁定版本或复制新版本。只生成或修改当前人物、场景的提示词时优先使用 jizuo_replace_design_prompt，无需提交完整设定。用户要求优化、调整或改写所引用人物或场景的提示词时，直接保存其图片基础提示词：先读取最新项目，基于最新完整 design 只修改 description，保留其他字段与素材引用，expectedRevision 使用最新值。仅讨论、提问、比较方案或明确要求先不保存时不调用；多个引用只处理用户指定目标。提取新增设定用 jizuo_extract_video_designs，手动新建时不传 id。锁定版本不可为优化而自行解锁或复制；仅在用户另行要求时单独解锁。版本冲突后重新核对，不直接重试覆盖；仅在工具成功返回后说明已保存，不自动生成图片。{{>design-description}}
```

```prompt:media-tool-13
将作品内已有图片归入人物或场景设定的具体视图；环景必须使用经过校验的环景原图。
```

```prompt:media-tool-14
从当前视频集原著和剧本提取人物与场景生成提示词，作为新设定追加并保留已有设定，不覆盖或改写已有版本，不自动生成图片。{{>design-description}}
```

```prompt:media-tool-15
使用已保存的制作稿提示词生成图片或单镜头视频。人物视图遵循 character-prompts skill，默认推荐 kind=image、designId、view=character-sheet、aspectRatio=16:9，一次生成上排全身、下排特写的六宫格合成图。明确要求三视图时用 view=turnaround。两种布局都只生成一张图，不要求先生成单独正面。仅在作者指定单视图时使用 front/side/back/expression/outfit。必须先有明确用户生成意图；先核对媒体模型和任务，不能盲目重复提交。
```

```prompt:media-tool-16
取消或恢复现有生成任务。结果未确认时不得重新提交。
```

```prompt:media-tool-17
为镜头选取当前作品已有图片或视频版本，保留所有候选。
```

```prompt:media-tool-18
按用户指定镜头和请求数量上限批量生成。batchId 使用 UUID，相同请求重试必须沿用原 batchId；超时不得换 ID 重交。
```

```prompt:media-tool-19
依据已选镜头创建粗剪。会替换时间线，仅在用户要求重建剪辑时使用。
```

```prompt:media-tool-20
修改当前视频剪辑：顺序、裁剪、拆分、音量、字幕、转场及配音定位，与用户界面使用同一时间线。
```

```prompt:media-tool-21
根据当前已保存时间线生成本地 MP4 成片，返回可跟进导出任务。
```

```prompt:media-tool-22
以 OpenAI 兼容语音模型生成 AI 配音素材，不自动修改时间线；单次最多4096字符，需有用户生成意图。
```

```prompt:media-tool-23
修改当前作品的素材名称，保留媒体内容和镜头引用。
```

```prompt:media-tool-24
查看当前视频集最近的不同剪辑版本，返回可恢复的版本号、片段数和时长。
```

```prompt:media-tool-25
剪辑恢复。恢复只修改当前时间线，保留镜头、素材和任务。
```

```prompt:media-tool-26
自动完成小说改编制作稿、缺少的镜头图片与视频、剪辑和导出。必须使用最新作品/视频集ID与用户明确的请求数量上限；默认制作稿后暂停供作者调整。requestId必须使用UUID，超时重试沿用原ID，禁止另起重复任务。已有镜头与人工剪辑会保留。
```

```prompt:media-tool-27
暂停、继续或取消自动制作。追加请求数量必须经用户明确要求，使用稳定requestId，重试不可换ID。先读取项目状态；未知收费任务先核对。
```

```prompt:media-tool-episode-sources
检查指定视频集实际采用的原著章节，按关联顺序返回卷名、章节名、ID及缺失状态。只读，不修改关联。参数为 input: {workId, episodeId, includeContent?}；includeContent:true 时返回各关联章节的完整 content、sourceWorkId 和 currentRevisionToken，小说来源 ID 与目标视频 workId 分离。省略时仅返回元数据。来源缺失或超过 100 章/100000 总字符时明确失败，不截断。
```


## 在文字聊天中生成图片与视频

普通聊天不需要先创建作品。用户明确要求生成，或已经同意包含媒体生成的创作任务时，主代理直接调用 `jizuo_generate_chat_media`，无需切换聊天模型、无需用户提供会话 ID 或作品 ID。AI 可以判断媒体是否有助于任务并主动建议；意图不清时询问用户。仅讨论、优化或保存提示词时不要自动生成。批量任务先说明数量和用途并获得确认，长篇或整集先做一份样例；一次调用只创建一个任务。

参数必须放入 `input` 对象，例如 `{"input":{"kind":"image","prompt":"雨夜街景，远处霓虹倒映在积水中","aspectRatio":"16:9"}}`。视频使用 `kind=video`，可以提供 `durationSeconds`。默认使用设置中的对应媒体模型；用户指定连接时使用真实 connectionId，不猜测。模型配置缺失或输入不受支持时说明问题，不悄悄更换模型。

参考图片先通过 `jizuo_list_chat_media` 读取当前对话的 attachments 和历史生成结果。来自用户附件的图片以 `referenceAttachmentIds` 指定，来自当前素材空间的结果图片以 `referenceAssetIds` 指定；不得编造 ID、读取其他会话或把图片编码填进 prompt。无法确定参考人物、画风还是动作时先询问关键用途。

生成工具返回 queued/running 只表示提交成功，随后用 `jizuo_list_chat_media` 查询；只有 succeeded 且有结果素材时才能声称完成。当前聊天会显示图片或视频卡片，历史对话可以恢复任务。修改画面时创建新结果，保留旧素材供对比。未知提交结果、断线或等待时间长时不能重新调用生成工具；用 `jizuo_control_chat_media` 查询恢复路径，只有明确的新生成请求才创建新任务。子代理不能提交媒体生成。
