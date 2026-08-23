{
  "variables": {
    "vinary_tree_sdk%": "<(module_root_dir)/../.build/native-sdk"
  },
  "targets": [{
    "target_name": "vinary_tree_native",
    "sources": ["src/addon.cc"],
    "include_dirs": [
      "<(vinary_tree_sdk)/include"
    ],
    "cflags_cc": ["-std=c++20", "-Wall", "-Wextra", "-Werror"],
    "conditions": [["OS=='linux'", {
      "libraries": [
        "-Wl,--start-group",
        "<(vinary_tree_sdk)/lib/libduallity.a",
        "<(vinary_tree_sdk)/lib/liblling_llang.a",
        "<(vinary_tree_sdk)/lib/libliblevenshtein.a",
        "<(vinary_tree_sdk)/lib/liblibdictenstein.a",
        "-Wl,--end-group",
        "-ldl",
        "-lpthread",
        "-lm"
      ]
    }], ["OS=='mac'", {
      "libraries": [
        "<(vinary_tree_sdk)/lib/libduallity.a",
        "<(vinary_tree_sdk)/lib/liblling_llang.a",
        "<(vinary_tree_sdk)/lib/libliblevenshtein.a",
        "<(vinary_tree_sdk)/lib/liblibdictenstein.a",
        "-liconv",
        "-framework CoreFoundation",
        "-framework Security"
      ]
    }], ["OS=='win'", {
      "libraries": [
        "<(vinary_tree_sdk)/lib/duallity.lib",
        "<(vinary_tree_sdk)/lib/lling_llang.lib",
        "<(vinary_tree_sdk)/lib/liblevenshtein.lib",
        "<(vinary_tree_sdk)/lib/libdictenstein.lib",
        "bcrypt.lib",
        "userenv.lib",
        "ws2_32.lib",
        "ntdll.lib",
        "synchronization.lib",
        "advapi32.lib"
      ]
    }]]
  }]
}
