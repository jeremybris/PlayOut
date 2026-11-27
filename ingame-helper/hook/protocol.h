// PlayOut in-game overlay: the pipe protocol (PROTOCOL.md). src/main/overlay/ingame/protocol.ts holds the same
// constants; its test reads this file to keep both in sync, so keep the `constexpr` lines in this simple form.
#pragma once
#include <cstdint>

namespace playout::protocol {

constexpr uint32_t PROTOCOL_VERSION = 1;
constexpr uint32_t HEADER_BYTES = 8;
constexpr uint32_t MAX_PAYLOAD_BYTES = 67108864;  // 64 MiB
constexpr uint32_t FRAME_HEADER_BYTES = 24;
constexpr uint32_t CONFIG_MAGIC = 0x43494F50;  // 'POIC'
constexpr uint32_t CONFIG_VERSION = 1;
constexpr const wchar_t* CONFIG_MAPPING_PREFIX = L"Local\\PlayOutIngame-";

// DLL -> PlayOut
constexpr uint32_t MSG_HELLO = 1;
constexpr uint32_t MSG_RESIZE = 2;
constexpr uint32_t MSG_PRESENTING = 3;
constexpr uint32_t MSG_FAULT = 4;
constexpr uint32_t MSG_LOG = 5;
constexpr uint32_t MSG_PONG = 6;
constexpr uint32_t MSG_UNSUPPORTED = 7;
constexpr uint32_t MSG_HIDDEN = 8;

// PlayOut -> DLL
constexpr uint32_t MSG_SHOW = 101;
constexpr uint32_t MSG_HIDE = 102;
constexpr uint32_t MSG_FRAME = 103;
constexpr uint32_t MSG_PING = 104;
constexpr uint32_t MSG_INPUT_RELEASE = 105;
constexpr uint32_t MSG_DETACH = 106;

#pragma pack(push, 4)
struct MessageHeader {
  uint32_t type;
  uint32_t length;
};

struct FrameHeader {
  uint32_t x;
  uint32_t y;
  uint32_t w;
  uint32_t h;
  uint32_t fullWidth;
  uint32_t fullHeight;
};

struct ConfigMapping {
  uint32_t magic;
  uint32_t version;
  uint32_t playoutPid;
  volatile long consumed;
  wchar_t pipe[256];
  char token[68];
};
#pragma pack(pop)

static_assert(sizeof(MessageHeader) == HEADER_BYTES, "header size");
static_assert(sizeof(FrameHeader) == FRAME_HEADER_BYTES, "frame header size");

}  // namespace playout::protocol
