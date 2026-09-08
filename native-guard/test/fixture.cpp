// Benign acceptance fixture: changes only its own unused test DLL function.
#include <windows.h>
#include <iostream>
#include <string>
int main() {
    HMODULE image=LoadLibraryW(L"jvm.dll");if(!image)return 2;
    unsigned char* marker=(unsigned char*)GetProcAddress(image,"Marker");if(!marker)return 3;
    std::cout << GetCurrentProcessId() << std::endl;
    std::string command;
    while(std::getline(std::cin,command)) {
        if(command=="patch") { DWORD old; if(!VirtualProtect(marker,1,PAGE_EXECUTE_READWRITE,&old))return 4;*marker^=0x01;DWORD ignored;VirtualProtect(marker,1,old,&ignored);FlushInstructionCache(GetCurrentProcess(),marker,1); }
        else if(command=="jit") { void* memory=VirtualAlloc(NULL,65536,MEM_COMMIT|MEM_RESERVE,PAGE_EXECUTE_READWRITE);if(!memory)return 5;ZeroMemory(memory,65536); }
        else if(command=="quit")break;
        std::cout << "ok" << std::endl;
    }
    return 0;
}
