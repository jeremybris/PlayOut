# PlayOut's in-game overlay: the helper exe (probe / inject / watch), the hook DLL loaded into the game, and a test
# game for scripts/ingame-harness.mjs. Build with `node scripts/build-ingame-helper.mjs` (x64 Release, MSVC, Ninja).
cmake_minimum_required(VERSION 3.21)
project(PlayOutIngame VERSION 0.1.0 LANGUAGES CXX RC)

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "PlayOut's in-game overlay builds for x64 only (run vcvars64.bat first)")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT (/MT): nothing to install next to the DLL inside the game's folder.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Each target names its exception model (/EHsc, or /EHa for the DLL); drop CMake's default.
string(REPLACE "/EHsc" "" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")

option(PLAYOUT_INGAME_TESTAPP "Build PlayOutIngameTest.exe (the harness's test game; not shipped)" ON)

configure_file(common/version.h.in ${CMAKE_CURRENT_BINARY_DIR}/generated/playout_version.h @ONLY)

set(PLAYOUT_COMMON_OPTIONS /W4 /WX /permissive- /utf-8 /Zc:__cplusplus /guard:cf /sdl)
set(PLAYOUT_COMMON_DEFS UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)

# The overlay shaders, compiled by fxc into headers (byte arrays) at build time.
find_program(PLAYOUT_FXC fxc
  HINTS "$ENV{WindowsSdkVerBinPath}/x64" "$ENV{WindowsSdkBinPath}/$ENV{WindowsSDKVersion}/x64"
  REQUIRED)
set(SHADER_SRC ${CMAKE_CURRENT_SOURCE_DIR}/hook/overlay.hlsl)
set(SHADER_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated)
add_custom_command(
  OUTPUT ${SHADER_DIR}/overlay_vs.h ${SHADER_DIR}/overlay_ps.h
  COMMAND ${PLAYOUT_FXC} /nologo /O3 /WX /T vs_4_0 /E VSMain /Vn g_overlayVs /Fh ${SHADER_DIR}/overlay_vs.h ${SHADER_SRC}
  COMMAND ${PLAYOUT_FXC} /nologo /O3 /WX /T ps_4_0 /E PSMain /Vn g_overlayPs /Fh ${SHADER_DIR}/overlay_ps.h ${SHADER_SRC}
  DEPENDS ${SHADER_SRC}
  COMMENT "Compiling the overlay shaders"
  VERBATIM)

# PlayOutIngame64.exe: runs beside PlayOut, never inside the game.
add_executable(PlayOutIngame64
  helper/main.cpp
  helper/version.rc)
target_include_directories(PlayOutIngame64 PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${SHADER_DIR})
target_compile_options(PlayOutIngame64 PRIVATE ${PLAYOUT_COMMON_OPTIONS} /EHsc)
target_compile_definitions(PlayOutIngame64 PRIVATE ${PLAYOUT_COMMON_DEFS})
target_link_libraries(PlayOutIngame64 PRIVATE psapi advapi32)
target_link_options(PlayOutIngame64 PRIVATE /guard:cf /SUBSYSTEM:CONSOLE)

# PlayOutOverlay64.dll: loaded into the game. /EHa: destructors also run when a hook catches a structured exception.
add_library(PlayOutOverlay64 SHARED
  hook/dllmain.cpp
  hook/state.cpp
  hook/pipe.cpp
  hook/present.cpp
  hook/renderer.cpp
  hook/input.cpp
  hook/vtable.cpp
  hook/version.rc
  ${SHADER_DIR}/overlay_vs.h
  ${SHADER_DIR}/overlay_ps.h)
target_include_directories(PlayOutOverlay64 PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${SHADER_DIR})
target_compile_options(PlayOutOverlay64 PRIVATE ${PLAYOUT_COMMON_OPTIONS} /EHa)
target_compile_definitions(PlayOutOverlay64 PRIVATE ${PLAYOUT_COMMON_DEFS})
target_link_libraries(PlayOutOverlay64 PRIVATE d3d11 dxgi dxguid psapi)
target_link_options(PlayOutOverlay64 PRIVATE /guard:cf)

if(PLAYOUT_INGAME_TESTAPP)
  add_executable(PlayOutIngameTest testapp/main.cpp)
  target_compile_options(PlayOutIngameTest PRIVATE ${PLAYOUT_COMMON_OPTIONS} /EHsc)
  target_compile_definitions(PlayOutIngameTest PRIVATE ${PLAYOUT_COMMON_DEFS})
  target_link_libraries(PlayOutIngameTest PRIVATE d3d11 dxgi xinput9_1_0)
  target_link_options(PlayOutIngameTest PRIVATE /SUBSYSTEM:CONSOLE)
endif()
