# 上游归属与许可声明

Pi Desktop 是集成 Pi 编码引擎的独立桌面客户端。Pi 上游项目为 [earendil-works/pi](https://github.com/earendil-works/pi)，本版本使用 `@earendil-works/pi-coding-agent@1.5.2` 和 `@earendil-works/pi-ai@1.5.2`。依赖及升级记录见 [UPSTREAM.md](UPSTREAM.md)。

以下保留 Pi 上游的 MIT 版权及许可声明。其他依赖的版权及许可分别以其发布包内的文件为准；此声明不将所有第三方依赖统一许可为 MIT。

## Anthropic Claude Agent SDK

客户端使用 `@anthropic-ai/claude-agent-sdk@0.3.325` 的 JavaScript core 接口驱动用户配置的本机 Claude Code CLI，不附带 SDK 可选的原生 Claude 二进制。发布包在 `runtime/licenses/claude-agent-sdk-LICENSE.md` 保留该依赖的许可声明：

© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

## Pi upstream — MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
