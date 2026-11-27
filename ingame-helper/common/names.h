// Case-insensitive matching of file base names against the anti-cheat lists (anticheat_names.h).
#pragma once
#include <cwctype>
#include <string>
#include <string_view>

namespace playout {

/** `text` in lower case (ASCII and the common Latin letters; enough for file names). */
inline std::wstring Lower(std::wstring_view text) {
  std::wstring out(text);
  for (auto& c : out) c = static_cast<wchar_t>(std::towlower(c));
  return out;
}

/** The part of `path` after its last backslash or slash. */
inline std::wstring BaseName(std::wstring_view path) {
  const auto cut = path.find_last_of(L"\\/");
  return std::wstring(cut == std::wstring_view::npos ? path : path.substr(cut + 1));
}

/**
 * Whether the lower-case base name `name` matches `pattern` (lower case): equal, or, for a pattern ending in '*',
 * starting with the rest of it.
 */
inline bool NameMatches(std::wstring_view name, std::wstring_view pattern) {
  if (!pattern.empty() && pattern.back() == L'*') {
    pattern.remove_suffix(1);
    return name.size() >= pattern.size() && name.substr(0, pattern.size()) == pattern;
  }
  return name == pattern;
}

/** The first pattern of `list` that the base name `name` (any case) matches, or nullptr. */
template <size_t N>
const wchar_t* FirstMatch(std::wstring_view name, const wchar_t* const (&list)[N]) {
  const std::wstring lower = Lower(name);
  for (const wchar_t* pattern : list) {
    if (NameMatches(lower, pattern)) return pattern;
  }
  return nullptr;
}

}  // namespace playout
